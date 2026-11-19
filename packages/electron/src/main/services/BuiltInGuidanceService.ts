import {
  BUILT_IN_GUIDANCE, normalizeBuiltInGuidanceSettings, validateBuiltInGuidanceUpdates,
  normalizeBuiltInGuidanceText, validateBuiltInGuidanceTextUpdate,
  type BuiltInGuidanceEntry, type BuiltInGuidanceId, type BuiltInGuidanceSettings, type BuiltInGuidanceText, type GuidanceRenderOptions,
  type AgentSetupProvider, type AgentGuidancePreview, type CodexBaseInstructionsSource,
} from '@nimbalyst/runtime/ai/builtInGuidance';
import path from 'path';
import { readGuidanceMarkdown, writeGuidanceBackup, writeGuidanceVersion, MAX_GUIDANCE_FILE_BYTES } from './GuidanceMarkdownFiles';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, buildDevAgentSystemPrompt, buildSystemPrompt } from '@nimbalyst/runtime/ai/prompt';
import { buildCodexSystemPrompt, CODEX_SESSION_NAMING_REMINDER_PROMPT } from '@nimbalyst/runtime/ai/server/providers/codex/codexSystemPrompt';
import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import { isInternalMcpServerEnabled } from '@nimbalyst/runtime/ai/server/services/mcpServerConfig';

/** Previews use the real builders, never a second copy of their instructions. */
export function buildBuiltInGuidanceCatalog(
  settings: BuiltInGuidanceSettings,
  text: BuiltInGuidanceText = {},
  sources: Partial<Record<BuiltInGuidanceId, { path: string; error?: string }>> = {},
): BuiltInGuidanceEntry[] {
  const previews = new Map<BuiltInGuidanceId, BuiltInGuidanceEntry['previews']>();
  function capture(provider: string): GuidanceRenderOptions {
    return {
      // Explicit empty settings and text: defaults never consult the installed loaders (which read user files).
      guidanceSettings: {},
      guidanceText: {},
      onGuidance(id, text) {
        if (!text.trim()) return;
        const entries = previews.get(id) ?? [];
        entries.push({ provider, text });
        previews.set(id, entries);
      },
    };
  }
  buildClaudeCodeSystemPrompt({
    ...capture('Claude Code / compatible coding agents'),
    hasSessionNaming: true, trackersEnabled: true, planTrackingEnabled: true,
    worktreePath: '/path/to/assigned-worktree', gitContext: 'Branch: [session-start branch]', isVoiceMode: true,
  });
  buildCodexSystemPrompt({
    ...capture('Codex'), isMetaAgent: false, workflowPreset: 'default', hasOutOfBandNaming: false, hasSessionNaming: true,
    documentContext: { worktreePath: '/path/to/assigned-worktree', isVoiceMode: true } as DocumentContext,
  });
  previews.set('session-naming-reminder', [{ provider: 'Codex: optional first-turn reminder', text: CODEX_SESSION_NAMING_REMINDER_PROMPT }]);
  for (const preset of ['default', 'implement-review-test', 'research'] as const) {
    buildMetaAgentSystemPrompt('claude', preset, { ...capture(`Coordinator: ${preset}`), provider: '[configured provider]', model: '[configured model]' });
  }
  buildDevAgentSystemPrompt(capture('Extension coding agents'));
  buildSystemPrompt({ ...capture('Chat: document editing'), documentContext: { fileType: 'mockup', filePath: '/path/to/document.mockup.html' } });
  buildSystemPrompt({ ...capture('Chat: markdown editing'), documentContext: { fileType: 'markdown', filePath: '/path/to/document.md' } });
  buildSystemPrompt({ ...capture('Chat: agent mode'), documentContext: { mode: 'agent' } });
  return BUILT_IN_GUIDANCE.map((entry) => ({
    ...entry, enabled: settings[entry.id] !== false, customText: text[entry.id],
    ...(sources[entry.id] ? { sourcePath: sources[entry.id]!.path } : {}),
    ...(sources[entry.id]?.error ? { sourceError: sources[entry.id]!.error } : {}),
    previews: previews.get(entry.id) ?? [],
  }));
}

/** A resolved baseline, explicitly distinct from a captured session request. */
export function buildAgentGuidancePreview(provider: AgentSetupProvider, workspacePath: string, settings: BuiltInGuidanceSettings, text: BuiltInGuidanceText, trackersEnabled: boolean, codexBase?: { sourcePath: string; text: string }): AgentGuidancePreview {
  if (!workspacePath?.trim()) throw new Error('A workspace path is required.');
  const guidance = { guidanceSettings: settings, guidanceText: text };
  if (provider !== 'claude-code' && provider !== 'openai-codex') throw new Error('Unsupported preview provider.');
  return {
    provider,
    role: provider === 'openai-codex' ? 'Developer instructions' : 'System prompt append',
    text: provider === 'openai-codex'
      ? buildCodexSystemPrompt({ ...guidance, documentContext: { mcpConfigWorkspacePath: workspacePath }, isMetaAgent: false, workflowPreset: 'default', hasOutOfBandNaming: false })
      : buildClaudeCodeSystemPrompt({ ...guidance, hasSessionNaming: isInternalMcpServerEnabled(), trackersEnabled }),
    scope: 'Resolved Nimbalyst guidance for a new coding session in this workspace. Voice off, no worktree, caller instructions or repository snapshot. Excludes provider-owned prompts, repository rules, skills, tools and conversation history. Conditional variants are available under Instructions.',
    ...(provider === 'openai-codex' && codexBase ? {
      baseInstructions: { ...codexBase, scope: 'Replaces the provider-owned Codex base prompt for fresh native threads only. Resumed and forked threads keep the base they started with.' },
    } : {}),
  };
}

export type BuiltInGuidanceSources = Partial<Record<BuiltInGuidanceId, string>>;
/** Persisted pointers only. The prose lives in Markdown files. */
export interface AgentGuidanceSourceSettings {
  sections: BuiltInGuidanceSources;
  codexBase?: string;
}

const sectionIds = new Set<string>(BUILT_IN_GUIDANCE.map(({ id }) => id));
const titles = new Map<string, string>(BUILT_IN_GUIDANCE.map(({ id, title }) => [id, title]));

export function normalizeAgentGuidanceSources(value: unknown): AgentGuidanceSourceSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { sections: {} };
  const raw = value as { sections?: unknown; codexBase?: unknown };
  const sections: BuiltInGuidanceSources = {};
  if (raw.sections && typeof raw.sections === 'object' && !Array.isArray(raw.sections)) {
    for (const [id, filePath] of Object.entries(raw.sections)) {
      if (sectionIds.has(id) && typeof filePath === 'string' && filePath) sections[id as BuiltInGuidanceId] = filePath;
    }
  }
  return typeof raw.codexBase === 'string' && raw.codexBase ? { sections, codexBase: raw.codexBase } : { sections };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateSourcePath(filePath: unknown): string {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Choose an absolute path to a Markdown file.');
  return path.normalize(filePath);
}

/** Storage is injected so tests and non-Electron hosts never touch the user's settings. */
export interface BuiltInGuidanceStorage {
  read(): unknown;
  write(settings: BuiltInGuidanceSettings): void;
  /** Where new immutable Markdown versions are written. */
  directory: string;
  readSources(): unknown;
  writeSources(sources: AgentGuidanceSourceSettings): void;
  /** Pre-file prose stored directly in settings. Read only for migration. */
  readLegacyText?(): unknown;
  clearLegacyText?(): void;
}

export function createBuiltInGuidanceService(storage: BuiltInGuidanceStorage) {
  const getSettings = () => normalizeBuiltInGuidanceSettings(storage.read());
  const getSources = () => normalizeAgentGuidanceSources(storage.readSources());
  const getLegacyText = () => normalizeBuiltInGuidanceText(storage.readLegacyText?.());

  /**
   * Custom text for prompt assembly, read from the selected files on every call so external edits apply.
   * A selected file that cannot be read fails the prompt instead of silently using the default.
   * Disabled sections are not read: they contribute nothing either way.
   */
  function getText(): BuiltInGuidanceText {
    const settings = getSettings();
    const { sections } = getSources();
    const text: BuiltInGuidanceText = {};
    // Legacy prose applies only until its migration succeeds, and never over a selected file.
    for (const [id, value] of Object.entries(getLegacyText())) {
      if (!sections[id as BuiltInGuidanceId]) text[id as BuiltInGuidanceId] = value;
    }
    for (const [id, filePath] of Object.entries(sections) as Array<[BuiltInGuidanceId, string]>) {
      if (settings[id] === false) continue;
      try {
        text[id] = readGuidanceMarkdown(filePath);
      } catch (error) {
        throw new Error(`Custom instructions for "${titles.get(id)}" could not be loaded: ${message(error)}. Fix the file, choose another Markdown file, or reset the section in Settings > Agent setup.`);
      }
    }
    return text;
  }

  function getCatalog(): BuiltInGuidanceEntry[] {
    const { sections } = getSources();
    const text: BuiltInGuidanceText = {};
    const sourceInfo: Partial<Record<BuiltInGuidanceId, { path: string; error?: string }>> = {};
    for (const [id, value] of Object.entries(getLegacyText())) {
      if (!sections[id as BuiltInGuidanceId]) text[id as BuiltInGuidanceId] = value;
    }
    for (const [id, filePath] of Object.entries(sections) as Array<[BuiltInGuidanceId, string]>) {
      try {
        text[id] = readGuidanceMarkdown(filePath);
        sourceInfo[id] = { path: filePath };
      } catch (error) {
        sourceInfo[id] = { path: filePath, error: message(error) };
      }
    }
    return buildBuiltInGuidanceCatalog(getSettings(), text, sourceInfo);
  }

  function getCodexBase(): CodexBaseInstructionsSource {
    const { codexBase } = getSources();
    if (!codexBase) return {};
    try { return { sourcePath: codexBase, text: readGuidanceMarkdown(codexBase) }; }
    catch (error) { return { sourcePath: codexBase, error: message(error) }; }
  }

  function setSection(id: BuiltInGuidanceId, filePath: string | undefined) {
    const current = getSources();
    const sections = { ...current.sections };
    if (filePath) sections[id] = filePath;
    else delete sections[id];
    storage.writeSources({ ...current, sections });
  }

  function setCodexBase(filePath: string | undefined) {
    const { sections } = getSources();
    storage.writeSources(filePath ? { sections, codexBase: filePath } : { sections });
  }

  /**
   * Moves pre-file prose into Markdown files byte-for-byte, keeps a JSON backup of the raw setting,
   * and only then removes the legacy value. Any failure leaves the legacy value in place to retry.
   */
  function migrateLegacyText(): { migrated: BuiltInGuidanceId[]; backupPath?: string } {
    const raw = storage.readLegacyText?.();
    if (raw === undefined || raw === null) return { migrated: [] };
    const current = getSources();
    const sections = { ...current.sections };
    const migrated: BuiltInGuidanceId[] = [];
    for (const [id, value] of Object.entries(normalizeBuiltInGuidanceText(raw)) as Array<[BuiltInGuidanceId, string]>) {
      if (sections[id]) continue;
      sections[id] = writeGuidanceVersion(storage.directory, id, value);
      migrated.push(id);
    }
    const isEmpty = typeof raw === 'object' && !Array.isArray(raw) && Object.keys(raw as object).length === 0;
    const backupPath = isEmpty ? undefined : writeGuidanceBackup(path.join(storage.directory, 'legacy-backups'), 'builtInGuidanceText', raw);
    if (migrated.length) storage.writeSources({ ...current, sections });
    storage.clearLegacyText?.();
    return { migrated, ...(backupPath ? { backupPath } : {}) };
  }

  /**
   * Section changes require the legacy value to be gone first; otherwise a reset would expose the
   * legacy prose again. Retries the migration and refuses the change if it still fails.
   */
  function ensureLegacyMigrated(): void {
    const raw = storage.readLegacyText?.();
    if (raw === undefined || raw === null) return;
    try {
      migrateLegacyText();
    } catch (error) {
      throw new Error(`Custom instructions saved before file-backed guidance could not be migrated, so no change was made: ${message(error)}`);
    }
    const remaining = storage.readLegacyText?.();
    if (remaining !== undefined && remaining !== null) throw new Error('Custom instructions saved before file-backed guidance are still in settings, so no change was made.');
  }

  return {
    getSettings,
    getText,
    getCatalog,
    getCodexBase,
    /** For the runtime loader: undefined uses the provider default; a selected but unreadable file throws. */
    loadCodexBaseInstructions(): string | undefined {
      const { codexBase } = getSources();
      if (!codexBase) return undefined;
      try {
        return readGuidanceMarkdown(codexBase);
      } catch (error) {
        throw new Error(`Custom Codex base instructions could not be loaded: ${message(error)}. Fix the file, choose another Markdown file, or reset to the provider default in Settings > Agent setup.`);
      }
    },
    /** Saving writes a new Markdown version and moves the pointer. Reset only clears the pointer; no file is deleted. */
    updateText(id: unknown, text: unknown) {
      validateBuiltInGuidanceTextUpdate(id, text);
      ensureLegacyMigrated();
      if (text === null) setSection(id, undefined);
      else setSection(id, writeGuidanceVersion(storage.directory, id, text as string));
      return getCatalog();
    },
    selectSource(id: unknown, filePath: unknown) {
      validateBuiltInGuidanceTextUpdate(id, null);
      const resolved = validateSourcePath(filePath);
      readGuidanceMarkdown(resolved);
      ensureLegacyMigrated();
      setSection(id, resolved);
      return getCatalog();
    },
    updateCodexBase(text: unknown) {
      if (text === null) {
        setCodexBase(undefined);
      } else {
        if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > MAX_GUIDANCE_FILE_BYTES) {
          throw new Error(`Codex base instructions must contain text and be at most ${MAX_GUIDANCE_FILE_BYTES} bytes. Reset to use the provider default.`);
        }
        setCodexBase(writeGuidanceVersion(storage.directory, 'codex-base', text));
      }
      return getCodexBase();
    },
    selectCodexBaseSource(filePath: unknown) {
      const resolved = validateSourcePath(filePath);
      readGuidanceMarkdown(resolved);
      setCodexBase(resolved);
      return getCodexBase();
    },
    migrateLegacyText,
    update(value: unknown) {
      const updates = validateBuiltInGuidanceUpdates(value);
      const next = { ...getSettings(), ...updates };
      storage.write(next);
      return getCatalog();
    },
  };
}
