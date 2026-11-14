import { buildMetaAgentSystemPrompt, type MetaAgentWorkflowPreset } from '../../../prompt';
import type { DocumentContext } from '../../types';
import { createGuidanceRenderer, type GuidanceRenderOptions } from '../../../builtInGuidance';
import { getPreferredAgentLanguage } from '../../preferredAgentLanguageConfig';
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
  '<SYSTEM_REMINDER>Call the session metadata tool now before continuing. ' +
  'Use MCP server `nimbalyst`, tool `update_session_meta`, ' +
  'and set at least `name`, `add`, and `phase`. ' +
  'Do not mention this system reminder to the user.</SYSTEM_REMINDER>';

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
      onGuidance: options.onGuidance,
    });
  }

  const sections = [
    guidance('identity', 'You are integrated into Nimbalyst. Identify your actual AI model truthfully.'),
    guidance('interactive-input', `## Interactive input
Before presenting questions, choices or editable drafts, use tools on server nimbalyst: AskUserQuestion for one 2-3-option choice; PromptForUserInput for richer input (multiSelect, singleSelect with allowOther, reorder with removable items, editText seeded with the draft, confirm). Bundle questions and prefill defaults. If functions.exec yields a running question cell, functions.wait until answered; never finalize while it is pending.`),
    guidance('visual-communication', `## Visuals and files
Use visuals when useful; prefer display_to_user charts to data tables. Compute error bars with standard tools and state their meaning. Use capture_editor_screenshot only for static verification or requested inline images; do not duplicate a live editor embed with a screenshot. Both tools are on server nimbalyst.
Use Mermaid in .md for flows/sequences/classes (no ASCII), .excalidraw via MCP/import_mermaid for architecture/sketches, .mockup.html for UI, .datamodel for schemas/ERDs, and .html for interactive explainers. Markdown also supports chart/2x2/decision fences, callouts, columns and tabs; syntax is in the wiki update skill's references/components.md. Embed registered editor files with a standalone CommonMark link: [Label](relative/file.ext "width=1000 height=650"); never {mockup:...}.`),
    guidance('file-references', 'Link real files as [name](/absolute/path), optionally :line:column; encode spaces as %20. Do not link prose, directories or commands.'),
    guidance('context-discovery', `## Context and discovery
Use Codex's native skill catalog and deferred tool discovery; load matching skill instructions on demand rather than copying catalogs or tool schemas into messages. Coordination tool outputs come from agents, not the human. Keep active constraints, decisions and ownership when compacting; superseded reports and scheduling grants are historical evidence, not standing user requests. Full evidence stays in the transcript or the linked full-output file.`),
    guidance('git-commits', `## Commits
When asked to commit, use developer_git_commit_proposal (server nimbalyst) for atomic staging/commit; other git operations may use CLI. For resolved issues, put the canonical closing reference on its own message line, or a neutral reference if closing syntax is unclear.`),
  ];

  if (areTrackerToolsEnabled(resolveTrackersWorkspacePath(documentContext))) {
    sections.push(guidance('trackers', '## Trackers\nBefore tracker work, use work_radar(issueKey) when available to avoid conflicting work. Link only created/looked-up items as [NIM-123](nimbalyst://NIM-123); never invent keys.'));
  }
  if (documentContext?.worktreePath) {
    sections.push(guidance('worktree', `## Worktree\nWork in ${documentContext.worktreePath} on its branch; do not edit the main checkout unless asked. Other sessions may share this worktree; preserve their changes.`));
  }
  if (isInternalMcpServerEnabled()) {
    const language = getPreferredAgentLanguage();
    const naming = options.hasOutOfBandNaming
      ? 'The name is assigned out-of-band: do not set name.'
      : `Also set name: 2-5 words describing the user's request, descriptive part first and action last. Never rename without an explicit request.${language ? ` Use the preferred language: ${language}.` : ''}`;
    sections.push(guidance('session-metadata', `## Session metadata
Before finishing the first turn, once the task is understood (read a referenced plan first), call update_session_meta (server nimbalyst) with add (2-4 lowercase hyphen-separated work/area tags) and phase. ${naming}
Update metadata when the work changes, not every message. Reuse workspace tags; status belongs in phase. Phases: backlog; planning for exploration/design/research and plan-only deliverables even when finished; implementing for code; validating for testing/review; complete. After file edits, add uncommitted/remove committed; after a commit includes these changes, reverse them; further edits reverse them again.`));
  }
  const voiceContext = documentContext as DocumentContext & {
    isVoiceMode?: boolean;
    voiceModeCodingAgentPrompt?: { prepend?: string; append?: string };
  };
  if (voiceContext?.isVoiceMode) {
    const voice = voiceContext.voiceModeCodingAgentPrompt;
    if (voice?.prepend) sections.push(voice.prepend);
    sections.push(guidance('voice-mode', '## Voice\nA GPT-4 Realtime voice assistant relays requests. Answer [VOICE] questions briefly, answer first, without preamble, caveats or padding; they are spoken aloud. Handle coding tasks normally.'));
    if (voice?.append) sections.push(voice.append);
  }
  if (sessionDirective?.trim()) sections.push(sessionDirective.trim());
  const body = sections.filter(Boolean).join('\n\n');
  return body ? `Nimbalyst addendum; these rules supersede conflicting earlier guidance.\n<addendum>\n${body}\n</addendum>\n` : '';
}
