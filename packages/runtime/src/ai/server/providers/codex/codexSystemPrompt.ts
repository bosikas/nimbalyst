import { instructionTemplate } from '../../../instructionTemplates';
import { buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../../prompt';
import { buildCompactAgentSystemPrompt, type CompactAgentSystemPromptOptions } from '../compactAgentSystemPrompt';

export interface CodexSystemPromptOptions extends CompactAgentSystemPromptOptions {
  provider?: 'openai-codex' | 'openai-codex-acp';
  isMetaAgent: boolean;
  workflowPreset: MetaAgentWorkflowPreset;
  model?: string;
}

export const CODEX_SESSION_NAMING_REMINDER_PROMPT =
  instructionTemplate('codexSystemPrompt.naming-reminder');

/** App rules re-sent to Codex as developer instructions at the head of each turn. */
export function buildCodexSystemPrompt(options: CodexSystemPromptOptions): string {
  if (options.isMetaAgent) {
    return buildMetaAgentSystemPrompt('codex', options.workflowPreset, {
      provider: options.provider ?? 'openai-codex',
      model: options.model,
      sessionDirective: options.sessionDirective,
      generateSummary: options.generateSummary,
      hasOutOfBandNaming: options.hasOutOfBandNaming,
      guidanceSettings: options.guidanceSettings,
      guidanceText: options.guidanceText,
      onGuidance: options.onGuidance,
    });
  }

  return buildCompactAgentSystemPrompt(options);
}
