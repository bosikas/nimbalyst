import { instructionTemplate } from '../../../instructionTemplates';
import { buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../../prompt';
import type { DocumentContext } from '../../types';
import { createGuidanceRenderer, type GuidanceRenderOptions } from '../../../builtInGuidance';
import { getPreferredAgentLanguage } from '../../preferredAgentLanguageConfig';
import { SESSION_WORK_SUMMARY_GUIDANCE } from '../../../sessionWorkSummary';
import {
  areTrackerToolsEnabled,
  isInternalMcpServerEnabled,
  resolveTrackersWorkspacePath,
} from '../../services/mcpServerConfig';

export interface CodexSystemPromptOptions extends GuidanceRenderOptions {
  documentContext?: DocumentContext;
  isMetaAgent: boolean;
  workflowPreset: MetaAgentWorkflowPreset;
  model?: string;
  /** `metadata.sessionDirective`, frozen per session by `BaseAgentProvider.getSessionDirective`. */
  sessionDirective?: string;
  /** The session was titled by its caller, so the agent must not name it (frozen at the first turn). */
  hasOutOfBandNaming: boolean;
}

export const CODEX_SESSION_NAMING_REMINDER_PROMPT =
  instructionTemplate('codexSystemPrompt.naming-reminder');

/**
 * Compact Codex integration rules. Re-sent at the head of
 * every turn as developer instructions. Session inputs stay stable except for
 * deliberate changes to the app-wide guidance settings.
 */
export function buildCodexSystemPrompt(options: CodexSystemPromptOptions): string {
  const guidance = createGuidanceRenderer(options);
  const { documentContext, sessionDirective } = options;
  if (options.isMetaAgent) {
    return buildMetaAgentSystemPrompt('codex', options.workflowPreset, {
      provider: 'openai-codex',
      model: options.model,
      sessionDirective,
      guidanceSettings: options.guidanceSettings,
      guidanceText: options.guidanceText,
      onGuidance: options.onGuidance,
    });
  }

  const sections = [
    guidance('identity', instructionTemplate('codex.identity')),
    guidance('interactive-input', instructionTemplate('codex.interactive-input')),
    guidance('visual-communication', instructionTemplate('codex.visual-communication')),
    guidance('file-references', instructionTemplate('codex.file-references')),
    guidance('context-discovery', instructionTemplate('codex.context-discovery')),
    guidance('git-commits', instructionTemplate('codex.git-commits')),
  ];

  if (areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext))) {
    sections.push(guidance('trackers', instructionTemplate('codex.trackers')));
  }
  if (documentContext?.worktreePath) {
    sections.push(guidance('worktree', instructionTemplate('codex.worktree', [documentContext.worktreePath])));
  }
  if (isInternalMcpServerEnabled()) {
    const language = getPreferredAgentLanguage();
    const naming = options.hasOutOfBandNaming
      ? instructionTemplate('codex.session-name-assigned')
      : instructionTemplate('codex.session-name', [language ? instructionTemplate('codex.language', [language]) : '']);
    sections.push(guidance('session-metadata', instructionTemplate('codex.session-metadata', [naming, SESSION_WORK_SUMMARY_GUIDANCE])));
  }
  const voiceContext = documentContext as DocumentContext & {
    isVoiceMode?: boolean;
    voiceModeCodingAgentPrompt?: { prepend?: string; append?: string };
  };
  if (voiceContext?.isVoiceMode) {
    const voice = voiceContext.voiceModeCodingAgentPrompt;
    if (voice?.prepend) sections.push(voice.prepend);
    sections.push(guidance('voice-mode', instructionTemplate('codex.voice-mode')));
    if (voice?.append) sections.push(voice.append);
  }
  if (sessionDirective?.trim()) sections.push(sessionDirective.trim());
  const body = sections.filter(Boolean).join('\n\n');
  return body ? instructionTemplate('codex.addendum', [body]) : '';
}
