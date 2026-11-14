import {
  BUILT_IN_GUIDANCE, normalizeBuiltInGuidanceSettings, validateBuiltInGuidanceUpdates,
  type BuiltInGuidanceEntry, type BuiltInGuidanceId, type BuiltInGuidanceSettings, type GuidanceRenderOptions,
} from '@nimbalyst/runtime/ai/builtInGuidance';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, buildDevAgentSystemPrompt, buildSystemPrompt } from '@nimbalyst/runtime/ai/prompt';
import { buildCodexSystemPrompt, CODEX_SESSION_NAMING_REMINDER_PROMPT } from '@nimbalyst/runtime/ai/server/providers/codex/codexSystemPrompt';
import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';

/** Previews use the real builders, never a second copy of their instructions. */
export function buildBuiltInGuidanceCatalog(settings: BuiltInGuidanceSettings): BuiltInGuidanceEntry[] {
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
  previews.get('session-metadata')?.push({ provider: 'Codex: optional first-turn reminder', text: CODEX_SESSION_NAMING_REMINDER_PROMPT });
  for (const preset of ['default', 'implement-review-test', 'research'] as const) {
    buildMetaAgentSystemPrompt('claude', preset, { ...capture(`Coordinator: ${preset}`), provider: '[configured provider]', model: '[configured model]' });
  }
  buildDevAgentSystemPrompt(capture('Extension coding agents'));
  buildSystemPrompt({ ...capture('Chat: document editing'), documentContext: { fileType: 'mockup', filePath: '/path/to/document.mockup.html' } });
  buildSystemPrompt({ ...capture('Chat: markdown editing'), documentContext: { fileType: 'markdown', filePath: '/path/to/document.md' } });
  buildSystemPrompt({ ...capture('Chat: agent mode'), documentContext: { mode: 'agent' } });
  return BUILT_IN_GUIDANCE.map((entry) => ({
    ...entry, enabled: settings[entry.id] !== false, previews: previews.get(entry.id) ?? [],
  }));
}

/** Storage is injected so tests and non-Electron hosts never touch the user's settings. */
export function createBuiltInGuidanceService(storage: { read(): unknown; write(settings: BuiltInGuidanceSettings): void }) {
  const getSettings = () => normalizeBuiltInGuidanceSettings(storage.read());
  return {
    getSettings,
    getCatalog: () => buildBuiltInGuidanceCatalog(getSettings()),
    update(value: unknown) {
      const updates = validateBuiltInGuidanceUpdates(value);
      const next = { ...getSettings(), ...updates };
      storage.write(next);
      return buildBuiltInGuidanceCatalog(next);
    },
  };
}
