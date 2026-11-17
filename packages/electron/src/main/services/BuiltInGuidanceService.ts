import {
  BUILT_IN_GUIDANCE, normalizeBuiltInGuidanceSettings, validateBuiltInGuidanceUpdates,
  normalizeBuiltInGuidanceText, validateBuiltInGuidanceTextUpdate,
  type BuiltInGuidanceEntry, type BuiltInGuidanceId, type BuiltInGuidanceSettings, type BuiltInGuidanceText, type GuidanceRenderOptions,
  type AgentSetupProvider, type AgentGuidancePreview,
} from '@nimbalyst/runtime/ai/builtInGuidance';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, buildDevAgentSystemPrompt, buildSystemPrompt } from '@nimbalyst/runtime/ai/prompt';
import { buildCodexSystemPrompt, CODEX_SESSION_NAMING_REMINDER_PROMPT } from '@nimbalyst/runtime/ai/server/providers/codex/codexSystemPrompt';
import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';
import { isInternalMcpServerEnabled } from '@nimbalyst/runtime/ai/server/services/mcpServerConfig';

/** Previews use the real builders, never a second copy of their instructions. */
export function buildBuiltInGuidanceCatalog(settings: BuiltInGuidanceSettings, text: BuiltInGuidanceText = {}): BuiltInGuidanceEntry[] {
  const previews = new Map<BuiltInGuidanceId, BuiltInGuidanceEntry['previews']>();
  function capture(provider: string): GuidanceRenderOptions {
    return {
      guidanceSettings: {},
      onGuidance(id, text) {
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
    ...capture('Codex'), isMetaAgent: false, workflowPreset: 'default', hasOutOfBandNaming: false,
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
    ...entry, enabled: settings[entry.id] !== false, customText: text[entry.id], previews: previews.get(entry.id) ?? [],
  }));
}

/** A resolved baseline, explicitly distinct from a captured session request. */
export function buildAgentGuidancePreview(provider: AgentSetupProvider, workspacePath: string, settings: BuiltInGuidanceSettings, text: BuiltInGuidanceText, trackersEnabled: boolean): AgentGuidancePreview {
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
  };
}

/** Storage is injected so tests and non-Electron hosts never touch the user's settings. */
export function createBuiltInGuidanceService(storage: {
  read(): unknown;
  write(settings: BuiltInGuidanceSettings): void;
  readText?(): unknown;
  writeText?(text: BuiltInGuidanceText): void;
}) {
  const getSettings = () => normalizeBuiltInGuidanceSettings(storage.read());
  const getText = () => normalizeBuiltInGuidanceText(storage.readText?.());
  const getCatalog = () => buildBuiltInGuidanceCatalog(getSettings(), getText());
  return {
    getSettings,
    getText,
    getCatalog,
    updateText(id: unknown, text: unknown) {
      validateBuiltInGuidanceTextUpdate(id, text);
      if (!storage.writeText) throw new Error('Guidance editing is unavailable in this host.');
      const next = { ...getText() };
      if (text === null) delete next[id];
      else next[id] = text as string;
      storage.writeText(next);
      return getCatalog();
    },
    update(value: unknown) {
      const updates = validateBuiltInGuidanceUpdates(value);
      const next = { ...getSettings(), ...updates };
      storage.write(next);
      return getCatalog();
    },
  };
}
