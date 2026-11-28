import { instructionTemplate } from './instructionTemplates';
import type { DocumentContext } from './types';
import { getPreferredAgentLanguage } from './server/preferredAgentLanguageConfig';
import { MCP_CORE } from './server/services/mcpTopology';
import { createGuidanceRenderer, type GuidanceRenderOptions } from './builtInGuidance';
import { SESSION_WORK_SUMMARY_GUIDANCE } from './sessionWorkSummary';

/**
 * Build session naming instructions section
 * Used by both coding and chat sessions
 */
type ToolReferenceStyle = 'claude' | 'codex';

function formatMcpToolReference(server: string, tool: string, style: ToolReferenceStyle): string {
  if (style === 'codex') {
    return `\`${tool}\` (server: \`${server}\`)`;
  }
  return `\`mcp__${server}__${tool}\``;
}

function buildSessionNamingSection(
  style: ToolReferenceStyle = 'claude',
  hasOutOfBandNaming: boolean = false,
  preferredAgentLanguage?: string
): string {
  // update_session_meta folds into the eager core `nimbalyst` server (MCP
  // consolidation Phase 5).
  const toolReference = formatMcpToolReference('nimbalyst', 'update_session_meta', style);

  const firstTurnSection = hasOutOfBandNaming
    ? instructionTemplate('session-metadata.first-turn-named')
    : instructionTemplate('session-metadata.first-turn-unnamed');

  const languageGuidance = preferredAgentLanguage
    ? instructionTemplate('session-metadata.language', [preferredAgentLanguage])
    : '';

  // Name guidelines are irrelevant when the name is assigned out-of-band.
  const nameGuidelines = hasOutOfBandNaming
    ? ''
    : instructionTemplate('session-metadata.name-guidelines', [languageGuidance]);

  return instructionTemplate('session-metadata.section', [toolReference, SESSION_WORK_SUMMARY_GUIDANCE, firstTurnSection, nameGuidelines]);
}

/**
 * Options for building agent system prompts (Claude Code, Codex, etc.)
 */
export const AGENT_ADDENDUM_VERSION = instructionTemplate('agent-addendum.version');

export interface ClaudeCodePromptOptions extends GuidanceRenderOptions {
  hasSessionNaming?: boolean;
  /**
   * When true, the prompt tells the agent NOT to set `name` — the session is
   * already named out-of-band (e.g. a spawn_session child titled by its parent).
   * When false, the agent names the session in-band via update_session_meta.
   * Pass true only when a name already exists or a real out-of-band path will
   * set one; otherwise the session is never named. (claude-code dropped its SDK
   * generateSessionTitle path in NIM-1988 and now names in-band by default.)
   */
  hasOutOfBandNaming?: boolean;
  /**
   * Preferred language for agent output (currently used only for the
   * auto-generated session name). BCP-47 code or common name, e.g. "ja",
   * "Japanese", "en", "fr". When set, the prompt tells the agent to write
   * the session name in this language. Empty/undefined means no preference --
   * the agent picks based on the conversation language.
   */
  preferredAgentLanguage?: string;
  /** @deprecated Use toolReferenceStyle instead */
  sessionNamingInstructionStyle?: ToolReferenceStyle;
  toolReferenceStyle?: ToolReferenceStyle;
  worktreePath?: string;
  /**
   * A pre-rendered git snapshot (branch, main branch, recent commits) to state
   * at the top of the session. #1177: only `claude-code` passes this, and only
   * because it sets CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1 to suppress the
   * CLI's own equivalent block — which the CLI rebuilds from the live working
   * tree on every resumed turn and thereby invalidates the prompt cache behind
   * it. The caller MUST resolve this once per session and freeze it; a value
   * that changes between turns re-introduces exactly the cache miss this
   * replaces. Providers that do not have the bug leave it undefined.
   */
  gitContext?: string;
  /**
   * Standing instructions for this one session, from its
   * `metadata.sessionDirective` (written by whoever created the session: an
   * automation, an extension). Appended last, never replacing the normal
   * prompt. Same freeze requirement as `gitContext`: resolve once per session.
   */
  sessionDirective?: string;
  isVoiceMode?: boolean;
  voiceModeCodingAgentPrompt?: {
    prepend?: string;
    append?: string;
  };
  enableAgentTeams?: boolean;
  /** When true, includes plan tracking frontmatter instructions and directs plans to nimbalyst-local/plans/ */
  planTrackingEnabled?: boolean;
  /**
   * When false, omits the tracker-references guidance (trackers are disabled
   * for the workspace, so the agent has no tracker tools to look items up with).
   * Defaults to true so providers that don't know the workspace state keep the
   * existing behavior.
   */
  trackersEnabled?: boolean;
  // Legacy fields - kept for backward compatibility but no longer used in prompt building
  /** @deprecated No longer used - prompt is now static for all session types */
  sessionType?: string;
  /** @deprecated Document context is now passed via user messages, not system prompt */
  documentContext?: DocumentContext;
  /** @deprecated Document context is now passed via user messages, not system prompt */
  documentTransition?: 'none' | 'opened' | 'closed' | 'switched' | 'modified';
  /** @deprecated Document context is now passed via user messages, not system prompt */
  documentDiff?: string;
}

/**
 * Unified system prompt builder for agent providers (Claude Code, Codex, etc.)
 * Builds a consistent system prompt for all session types with optional sections
 * based on context (worktree, voice mode, session naming).
 */
export function buildClaudeCodeSystemPrompt(options: ClaudeCodePromptOptions): string {
  const guidance = createGuidanceRenderer(options);
  const {
    hasSessionNaming = false,
    hasOutOfBandNaming = false,
    preferredAgentLanguage,
    sessionNamingInstructionStyle,
    toolReferenceStyle = 'claude',
    worktreePath,
    gitContext,
    sessionDirective,
    isVoiceMode = false,
    voiceModeCodingAgentPrompt,
    planTrackingEnabled = false,
    trackersEnabled = true,
  } = options;
  const effectiveToolReferenceStyle = sessionNamingInstructionStyle ?? toolReferenceStyle;
  // These are all core tools on the `nimbalyst` server, always-loaded so their
  // schemas are in context when the prompt below tells the model to use them.
  const displayToUserTool = formatMcpToolReference(MCP_CORE, 'display_to_user', effectiveToolReferenceStyle);
  const captureEditorScreenshotTool = formatMcpToolReference(MCP_CORE, 'capture_editor_screenshot', effectiveToolReferenceStyle);
  const askUserQuestionTool = formatMcpToolReference(MCP_CORE, 'AskUserQuestion', effectiveToolReferenceStyle);
  const promptForUserInputTool = formatMcpToolReference(MCP_CORE, 'PromptForUserInput', effectiveToolReferenceStyle);
  const gitCommitProposalTool = formatMcpToolReference('nimbalyst-host', 'developer_git_commit_proposal', effectiveToolReferenceStyle);

  let prompt = instructionTemplate('claude.addendum-open') + `Nimbalyst addendum version ${AGENT_ADDENDUM_VERSION}\n\n`;
  prompt += guidance('identity', instructionTemplate('claude.identity'));
  prompt += guidance('interactive-input', instructionTemplate('claude.interactive-input', [askUserQuestionTool, promptForUserInputTool, effectiveToolReferenceStyle === 'codex' ? instructionTemplate('claude.interactive-exec-wait') : '']));
  prompt += guidance('visual-communication', instructionTemplate('claude.visual-communication', [displayToUserTool, captureEditorScreenshotTool]));
  prompt += guidance('file-references', '\n\n## File References\n' + instructionTemplate('agent-addendum.file-references'));
  prompt += guidance('context-discovery', '\n\n' + instructionTemplate('agent-addendum.context-discovery', ['Delegation', 'delegating']));

  // Tracker guidance only makes sense when the workspace has tracker tools.
  if (trackersEnabled) {
    prompt += guidance('trackers', instructionTemplate('claude.trackers'));
  }

  // Add plan tracking frontmatter instructions when enabled
  if (planTrackingEnabled) {
  prompt += guidance('plan-tracking', instructionTemplate('claude.plan-tracking'));
  }

  // Add worktree warning if in worktree
  if (worktreePath) {
    prompt += guidance('worktree', instructionTemplate('claude.worktree', [worktreePath]));
  }

  prompt += guidance('git-commits', instructionTemplate('claude.git-commits', [gitCommitProposalTool]));

  // Frozen for the life of the session — see the gitContext doc comment. The
  // "will not update" wording is literally true here, unlike the CLI's block
  // which silently refreshes on every process spawn.
  if (gitContext) {
    prompt += guidance('repository-context', instructionTemplate('claude.repository-context', [gitContext]));
  }

  // Add session naming if available. Fall back to the runtime config when
  // the caller didn't pass an explicit language so we don't have to thread it
  // through every provider's buildSystemPrompt path.
  if (hasSessionNaming) {
    const effectiveLanguage = preferredAgentLanguage ?? getPreferredAgentLanguage();
    prompt += guidance('session-metadata', buildSessionNamingSection(effectiveToolReferenceStyle, hasOutOfBandNaming, effectiveLanguage));
  }

  // Add voice mode context if applicable
  if (isVoiceMode) {
    // Apply custom prepend if configured
    if (voiceModeCodingAgentPrompt?.prepend) {
      prompt += `\n\n${voiceModeCodingAgentPrompt.prepend}`;
    }

    prompt += guidance('voice-mode', instructionTemplate('claude.voice-mode'));

    // Apply custom append if configured
    if (voiceModeCodingAgentPrompt?.append) {
      prompt += `\n\n${voiceModeCodingAgentPrompt.append}`;
    }
  }

  // No reporting guidance here: this addendum reaches every session, and a
  // spawned child's reporting duty comes only from its spawn (the directive).
  const directive = sessionDirective?.trim();
  if (directive) {
    prompt += `\n${directive}\n`;
  }
  return prompt + `
</addendum>
`;
}

export type MetaAgentWorkflowPreset = 'default' | 'implement-review-test' | 'research';

export function buildCodexMetadataSections(
  guidance: ReturnType<typeof createGuidanceRenderer>, hasOutOfBandNaming = false, generateSummary = true,
  nameInstruction: 'codex.session-name' | 'vibe.session-name' = 'codex.session-name',
): string[] {
  const language = getPreferredAgentLanguage();
  const naming = hasOutOfBandNaming ? instructionTemplate('codex.session-name-assigned')
    : instructionTemplate(nameInstruction, [language ? instructionTemplate('codex.language', [language]) : '']);
  const sections = [guidance('session-metadata', instructionTemplate('codex.session-metadata', [naming]))];
  if (generateSummary) sections.push(guidance('session-summary', instructionTemplate('codex.session-summary')));
  return sections;
}

export function buildMetaAgentSystemPrompt(
  style: ToolReferenceStyle = 'claude',
  workflowPreset: MetaAgentWorkflowPreset = 'default',
  options?: GuidanceRenderOptions & {
    provider?: string;
    model?: string;
    modelDisplayName?: string;
    generateSummary?: boolean;
    hasOutOfBandNaming?: boolean;
    /** See `ClaudeCodePromptOptions.sessionDirective`; an orchestrator can carry standing instructions too. */
    sessionDirective?: string;
  }
): string {
  // Meta-agent tools fold onto the deferred `nimbalyst-host` server, and
  // update_session_meta onto the eager core `nimbalyst` (MCP consolidation Phase 5).
  const listSpawnedSessionsTool = formatMcpToolReference('nimbalyst-host', 'list_spawned_sessions', style);
  const listWorktreesTool = formatMcpToolReference('nimbalyst-host', 'list_worktrees', style);
  const createSessionTool = formatMcpToolReference('nimbalyst-host', 'create_session', style);
  const getSessionStatusTool = formatMcpToolReference('nimbalyst-host', 'get_session_status', style);
  const getSessionResultTool = formatMcpToolReference('nimbalyst-host', 'get_session_result', style);
  const sendPromptTool = formatMcpToolReference('nimbalyst-host', 'send_prompt', style);
  const respondToPromptTool = formatMcpToolReference('nimbalyst-host', 'respond_to_prompt', style);
  const updateSessionMetaTool = formatMcpToolReference('nimbalyst', 'update_session_meta', style);
  // Meta-agent self-identity. Built-in providers (claude-code, openai-codex) pass no
  // modelDisplayName, so they keep the original 'running as provider X with model Y'
  // line unchanged. Extension agents (gemini) pass a display name and self-identify by
  // it, while still passing the raw ids in the child-spawn instruction.
  const identityLine = options?.modelDisplayName
    ? instructionTemplate('coordinator.identity-display-name', [options.modelDisplayName, createSessionTool, options?.provider ?? 'unknown', options?.model ?? 'default'])
    : instructionTemplate('coordinator.identity-provider-model', [options?.provider ?? 'unknown', options?.model ?? 'default', createSessionTool]);

  const consumeInboxTool = formatMcpToolReference('nimbalyst-host', 'consume_session_inbox', style);
  // Base orchestration prompt — always included
  const askUserQuestionTool = formatMcpToolReference(MCP_CORE, 'AskUserQuestion', style);
  const promptForUserInputTool = formatMcpToolReference(MCP_CORE, 'PromptForUserInput', style);
  const guidance = createGuidanceRenderer(options);
  const metadataCall = style === 'codex' ? '' : instructionTemplate('coordinator.metadata-call', [updateSessionMetaTool]);
  let prompt = instructionTemplate('coordinator.instructions', [style === 'codex' ? '' : SESSION_WORK_SUMMARY_GUIDANCE, listWorktreesTool, createSessionTool, listSpawnedSessionsTool, getSessionStatusTool, getSessionResultTool, consumeInboxTool, sendPromptTool, respondToPromptTool, updateSessionMetaTool, createSessionTool, getSessionStatusTool, createSessionTool, updateSessionMetaTool, respondToPromptTool, identityLine, metadataCall, askUserQuestionTool, promptForUserInputTool]);

  // Workflow preset section
  if (workflowPreset === 'implement-review-test') {
    prompt += instructionTemplate('coordinator.workflow-implement-review-test');
  } else if (workflowPreset === 'research') {
    prompt += instructionTemplate('coordinator.workflow-research', [getSessionResultTool]);
  } else {
    // 'default' workflow
    prompt += instructionTemplate('coordinator.workflow-default', [getSessionResultTool]);
  }

  const sections = [guidance('coordination', prompt)];
  if (style === 'codex') sections.push(...buildCodexMetadataSections(guidance, options?.hasOutOfBandNaming, options?.generateSummary));
  return appendSessionDirective(sections.filter(Boolean).join('\n\n'), options?.sessionDirective);
}

/**
 * Append a session directive to a whole system prompt (the meta-agent persona,
 * or whatever prompt a tool-loop provider was handed). A blank directive
 * returns the prompt unchanged.
 */
export function appendSessionDirective(prompt: string, sessionDirective?: string): string {
  const directive = sessionDirective?.trim();
  if (!directive) return prompt;
  return prompt ? `${prompt}\n\n${directive}` : directive;
}

/**
 * System prompt for a STANDARD tool-loop agent session (e.g. Gemini)
 * that holds the read-only dev toolset (read_file / list_files / search_files).
 *
 * Role/persona text ONLY. The simulated tool-call envelope mechanics (the
 * {"tool_call":{...}} JSON contract, the worked example, the tool schemas) are
 * added by the backend's ToolLoopProtocol.buildInstructedSystemPrompt, so this
 * prompt never describes the JSON format. Mirrors how buildMetaAgentSystemPrompt
 * supplies persona text for the meta-agent extension path. A standard extension
 * session previously ran with an empty system prompt, so injecting this is
 * additive - it never overrides a base prompt that the session already had.
 */
export function buildDevAgentSystemPrompt(
  options?: GuidanceRenderOptions & { provider?: string; model?: string; modelDisplayName?: string }
): string {
  const identity = options?.modelDisplayName
    ? instructionTemplate('dev-agent.identity-display-name', [options.modelDisplayName])
    : instructionTemplate('dev-agent.identity-default');
  return createGuidanceRenderer(options)('dev-agent', instructionTemplate('dev-agent.instructions', [identity]));
}

/**
 * Options for building base AI provider system prompts
 */
export interface BasePromptOptions extends GuidanceRenderOptions {
  documentContext?: DocumentContext;
}

/**
 * Build system prompt for base AI providers (Claude, OpenAI, LM Studio, OpenAI Codex)
 * This is a simpler prompt builder without <addendum> tags or advanced features.
 * For Claude Code provider, use buildClaudeCodeSystemPrompt instead.
 *
 * NOTE: Document context (file path, cursor, selection, content) is now passed via
 * user message additions from DocumentContextService, not the system prompt.
 * This function only includes static configuration and tool usage instructions.
 */
export function buildSystemPrompt(documentContextOrOptions?: DocumentContext | BasePromptOptions): string {
  const guidance = createGuidanceRenderer(documentContextOrOptions as GuidanceRenderOptions | undefined);
  // Support both legacy (DocumentContext) and new (BasePromptOptions) signatures
  let documentContext: DocumentContext | undefined;

  if (documentContextOrOptions && 'documentContext' in documentContextOrOptions) {
    // New options format
    documentContext = documentContextOrOptions.documentContext;
  } else {
    // Legacy format - direct DocumentContext
    documentContext = documentContextOrOptions as DocumentContext | undefined;
  }

  // Check if this is an agentic coding session (no specific document context)
  const mode = documentContext?.mode;
  const hasDocument = !!(documentContext && (documentContext.filePath || documentContext.content));

  let base = guidance('identity', instructionTemplate('chat.identity'));

  // In agentic coding mode, there's no specific document - agent works across codebase
  if (mode === 'agent' && !hasDocument) {
    return base + guidance('document-editing', instructionTemplate('chat.agent-mode'));
  }

  // If no document is open, the prompt just uses the base - no special warning needed.
  // Document context (including "no document" state) is handled via user message additions.
  if (!hasDocument) {
    return base;
  }

  // Document context (file path, cursor, selection, content) is now passed via
  // user message additions from DocumentContextService, so we only include
  // static tool usage instructions here.

  const fileType = documentContext?.fileType || 'markdown';
  const isMockup = fileType === 'mockup';

  return base + guidance('document-editing', instructionTemplate('chat.document-editing', [isMockup ? instructionTemplate('chat.mockup-editing') : instructionTemplate('chat.file-editing', [fileType])]));
}


/**
 * Legacy wrapper for buildClaudeCodeSystemPrompt
 * @deprecated Use buildClaudeCodeSystemPrompt instead
 */
export function buildClaudeCodeSystemPromptAddendum(
  documentContext?: DocumentContext,
  hasSessionNaming?: boolean,
  toolReferenceStyle: ToolReferenceStyle = 'claude'
): string {
  const sessionType = (documentContext as any)?.sessionType;
  return buildClaudeCodeSystemPrompt({
    sessionType: sessionType || 'chat',
    hasSessionNaming,
    toolReferenceStyle,
    documentContext
  });
}
