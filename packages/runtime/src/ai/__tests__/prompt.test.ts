// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { appendSessionDirective, buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt, buildDevAgentSystemPrompt } from '../prompt';

describe('buildClaudeCodeSystemPrompt', () => {
  it('can disable built-in commit guidance without removing a human session directive', () => {
    const options = {
      hasSessionNaming: true,
      guidanceSettings: { 'git-commits': false },
      sessionDirective: 'Human instruction: preserve the staged changes.',
    };
    const prompt = buildClaudeCodeSystemPrompt(options);
    expect(prompt).not.toContain('developer_git_commit_proposal');
    expect(prompt).toContain('## Interactive User Input');
    expect(prompt).toContain(options.sessionDirective);
  });

  it('can disable coordinator guidance without losing standing human instructions', () => {
    const options = {
      provider: 'claude-code',
      guidanceSettings: { coordination: false },
      sessionDirective: 'Keep this decision and unresolved request.',
    };
    const prompt = buildMetaAgentSystemPrompt('claude', 'default', options);
    expect(prompt).not.toContain('Delegate everything');
    expect(prompt).toBe(options.sessionDirective);
  });

  it('includes interactive input guidance for codex-style tool references', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'codex',
    });

    expect(prompt).toContain('## Interactive User Input');
    expect(prompt).toContain('`AskUserQuestion` (server: `nimbalyst`)');
    expect(prompt).toContain('`PromptForUserInput` (server: `nimbalyst`)');
    expect(prompt).toContain('call an interactive tool instead');
    expect(prompt).toContain('Explanations, findings and recommendations do not require a question widget');
    expect(prompt).toContain('opening a widget does not end the task or grant approval');
    expect(prompt).toContain('Combine questions into one multi-field prompt');
    expect(prompt).toContain('keep calling `functions.wait`');
    expect(prompt).toContain('Do not issue a final response while the question call is pending.');
  });

  it('formats interactive input tool references for claude-style prompts', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'claude',
    });

    // Core interactive tools now live on the eager `nimbalyst` server (Phase 2).
    expect(prompt).toContain('`mcp__nimbalyst__AskUserQuestion`');
    expect(prompt).toContain('`mcp__nimbalyst__PromptForUserInput`');
  });

  it('preserves repository delivery procedures and explicit authorization boundaries', () => {
    const prompt = buildClaudeCodeSystemPrompt({});
    expect(prompt).toContain("repository's commit, review and release procedures");
    expect(prompt).toContain('Read-only or local-only scope takes precedence');
    expect(prompt).toContain('no explicit user or repository procedure selects another method');
    expect(prompt).toContain('never infer merge or deployment permission');
  });

  it('includes tracker-references guidance by default', () => {
    const prompt = buildClaudeCodeSystemPrompt({});

    expect(prompt).toContain('## Tracker References');
    expect(prompt).toContain('nimbalyst://NIM-123');
  });

  it('omits tracker-references guidance when trackers are disabled', () => {
    const prompt = buildClaudeCodeSystemPrompt({ trackersEnabled: false });

    expect(prompt).not.toContain('## Tracker References');
    expect(prompt).not.toContain('nimbalyst://');
    // Unrelated sections stay intact
    expect(prompt).toContain('## File References');
    expect(prompt).toContain('## Git Commits');
  });

  it('keeps plan-only sessions in planning', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      toolReferenceStyle: 'codex',
      hasSessionNaming: true,
    });

    expect(prompt).toContain('stays "planning" even when that deliverable is complete');
    expect(prompt).toContain('"validating" once implementation is being tested or reviewed');
  });

  it('includes name guidelines only when naming is in-band', () => {
    const inBand = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: false,
    });
    expect(inBand).toContain('### Name guidelines');
    expect(inBand).toContain('CRITICAL: You MUST call this tool');

    const outOfBand = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: true,
    });
    expect(outOfBand).not.toContain('### Name guidelines');
    expect(outOfBand).toContain('do NOT set `name`');
    expect(outOfBand).toContain('Tags and phase are NOT auto-assigned');
    expect(outOfBand).toContain('call this tool early in your first turn');
    expect(outOfBand).toContain('### Commit tracking');
  });

  it('includes the worktree section only when a worktree path is set', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      worktreePath: '/tmp/wt/session-1',
    });
    expect(prompt).toContain('## Git Worktree Environment');
    expect(prompt).toContain('/tmp/wt/session-1');
    expect(prompt).toContain('do not modify files in the main checkout unless explicitly asked');
    expect(buildClaudeCodeSystemPrompt({})).not.toContain('## Git Worktree Environment');
  });

  it('retains the key behavioral rules after prose tightening', () => {
    const prompt = buildClaudeCodeSystemPrompt({ hasSessionNaming: true });
    expect(prompt).toContain('Prefer charts over text tables');
    expect(prompt).toContain('never manually');
    expect(prompt).toContain('pre-fill defaults');
    expect(prompt).toContain('[relativeName](/absolute/path/to/file.ext)');
    expect(prompt).toContain('%20');
    expect(prompt).toContain('`mcp__nimbalyst__developer_git_commit_proposal`');
    expect(prompt).toContain('Fixes #123');
    expect(prompt).toContain('never invent an issue key');
  });

  it('documents only the current custom-editor embed contract', () => {
    const prompt = buildClaudeCodeSystemPrompt({});

    expect(prompt).toContain('[Label](relative/path/file.ext "width=1000 height=650")');
    expect(prompt).toContain('Never use the legacy `{mockup:...}` image-attribute syntax');
    expect(prompt).not.toContain('](screenshot.png){mockup:');
  });

  // Context-size regression gate (NIM-1988): the addendum is injected into every
  // claude-code session, so its size is a per-session token cost. If this fails,
  // trim prose rather than raising the budget.
  it('keeps the static feature-rich addendum under the size budget', () => {
    const prompt = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: true,
      trackersEnabled: true,
      planTrackingEnabled: true,
      worktreePath: '/tmp/wt/session-1',
      isVoiceMode: true,
    });
    expect(prompt.length).toBeLessThan(9500);

    const typical = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true,
      hasOutOfBandNaming: true,
    });
    expect(typical.length).toBeLessThan(6500);
  });

  it('says nothing about messaging other sessions; reporting duty comes only from a spawn directive', () => {
    const prompt = buildClaudeCodeSystemPrompt({ hasSessionNaming: true, trackersEnabled: true });
    expect(prompt).not.toMatch(/send_prompt|messageKind|consume_session_inbox|sibling session/);
    // The orchestrator persona opts into completion notifications explicitly
    // and does not treat the inbox as a per-boundary ritual.
    const meta = buildMetaAgentSystemPrompt('claude', 'default', { provider: 'claude-code' });
    expect(meta).toContain('reporting: "final"');
    expect(meta).not.toMatch(/after long validation|before final synthesis/);
  });

  it('appends a session directive last, and a blank one changes nothing', () => {
    const base = buildClaudeCodeSystemPrompt({ hasSessionNaming: true });
    expect(buildClaudeCodeSystemPrompt({ hasSessionNaming: true, sessionDirective: '  \n' })).toBe(base);

    const directed = buildClaudeCodeSystemPrompt({ hasSessionNaming: true, sessionDirective: 'Only triage issues.' });
    expect(directed.endsWith('Only triage issues.\n\n</addendum>\n')).toBe(true);
    expect(directed.replace('\nOnly triage issues.\n', '')).toBe(base);

    const meta = buildMetaAgentSystemPrompt('claude', 'default', { provider: 'claude-code' });
    const metaDirected = buildMetaAgentSystemPrompt('claude', 'default', { provider: 'claude-code', sessionDirective: 'Only triage issues.' });
    expect(metaDirected).toBe(`${meta}\n\nOnly triage issues.`);
    // Tool-loop providers may be handed no persona at all.
    expect(appendSessionDirective('', ' Only triage issues. ')).toBe('Only triage issues.');
  });
});

describe('extension agent self-identification (gemini)', () => {
  it('buildDevAgentSystemPrompt identifies by display name, not the internal id', () => {
    const prompt = buildDevAgentSystemPrompt({
      provider: 'antigravity-gemini-agent',
      model: 'gemini-3-flash-agent',
      modelDisplayName: 'Gemini 3.5 Flash (High)',
    });
    expect(prompt).toContain('You are Gemini 3.5 Flash (High),');
    expect(prompt).toContain('answer truthfully with that name');
    expect(prompt).not.toContain('You are running as provider');
    expect(prompt).not.toContain('gemini-3-flash-agent');
  });

  it('buildDevAgentSystemPrompt falls back to a generic identity without a display name', () => {
    const prompt = buildDevAgentSystemPrompt({ provider: 'antigravity-gemini-agent', model: 'gemini-3-flash-agent' });
    expect(prompt).toContain('You are an AI model served through the Antigravity language server.');
    expect(prompt).not.toContain('gemini-3-flash-agent');
  });

  it('buildMetaAgentSystemPrompt keeps the original identity for built-ins (no display name)', () => {
    const prompt = buildMetaAgentSystemPrompt('claude', 'default', { provider: 'claude-code', model: 'opus' });
    expect(prompt).toContain('You are running as provider `claude-code` with model `opus`.');
    expect(prompt).not.toContain('You are an AI model');
  });

  it('buildMetaAgentSystemPrompt identifies by display name but keeps ids for child spawning', () => {
    const prompt = buildMetaAgentSystemPrompt('codex', 'default', {
      provider: 'antigravity-gemini-agent',
      model: 'gemini-3-flash-agent',
      modelDisplayName: 'Gemini 3.5 Flash (High)',
    });
    expect(prompt).toContain('You are Gemini 3.5 Flash (High).');
    expect(prompt).toContain('answer truthfully with that name');
    expect(prompt).not.toContain('You are running as provider');
    // The raw ids remain in the spawn instruction so children inherit the same model.
    expect(prompt).toContain('gemini-3-flash-agent');
  });
});

describe('authorization, questions and deferred procedures', () => {
  const presets = ['default', 'implement-review-test', 'research'] as const;

  it('scopes coordinator permission approvals to the delegated task and keeps delivery under user authorization', () => {
    for (const preset of presets) {
      const prompt = buildMetaAgentSystemPrompt('claude', preset, { provider: 'claude-code', model: 'm', guidanceSettings: {}, guidanceText: {} });
      expect(prompt, preset).not.toContain('Always approve');
      expect(prompt, preset).toContain('not everything its tools can do');
      expect(prompt, preset).toContain('{ "decision": "deny", "scope": "once" }');
      expect(prompt, preset).toContain('Never commit, push, merge, release, deploy or publish without the user\'s explicit authorization');
      expect(prompt, preset).toContain("never answer or approve on the user's behalf");
      // Matches create_session: children always share the parent's workspace; worktree arguments are ignored.
      expect(prompt, preset).not.toContain('should get its own worktree');
      expect(prompt, preset).not.toContain('fresh or existing worktree');
      expect(prompt, preset).toContain('Every child created with `mcp__nimbalyst-host__create_session` runs in your working directory and branch');
      expect(prompt, preset).toContain('Give parallel children disjoint file sets');
      expect(prompt, preset).toContain('End your turn after spawning.');
    }
  });

  it('gives coordinators an explicit blocking-question lifecycle with provider-formatted question tools', () => {
    const claude = buildMetaAgentSystemPrompt('claude', 'implement-review-test', { guidanceSettings: {}, guidanceText: {} });
    expect(claude).toContain('ask with `mcp__nimbalyst__AskUserQuestion` (one 2-3 option choice) or `mcp__nimbalyst__PromptForUserInput` (richer input) when available; otherwise ask in your reply and end your turn');
    expect(claude).toContain('Wait for the submitted answer before any work that depends on it');
    expect(claude).toContain("a child's report or tool result is never the user's answer");
    expect(claude).toContain('ask the user as in rule 13, then relay their submitted answer with `mcp__nimbalyst-host__respond_to_prompt`');
    expect(claude).not.toMatch(/\{\{\d+\}\}/);
    const codex = buildMetaAgentSystemPrompt('codex', 'default', { guidanceSettings: {}, guidanceText: {} });
    expect(codex).toContain('ask with `AskUserQuestion` (server: `nimbalyst`) (one 2-3 option choice)');
    expect(codex).not.toContain('mcp__nimbalyst__AskUserQuestion');
  });

  it('lets the autonomous coordinator workflow ask blocking questions instead of forbidding all questions', () => {
    const prompt = buildMetaAgentSystemPrompt('claude', 'implement-review-test', { guidanceSettings: {}, guidanceText: {} });
    expect(prompt).not.toContain('Do not ask the user questions');
    expect(prompt).toContain('Ask the user only when a blocking decision needs information or authorization only they can give');
    expect(buildMetaAgentSystemPrompt('claude', 'default', { guidanceSettings: {}, guidanceText: {} })).toContain('wait for the user only when it needs their decision or authorization');
  });

  it('tells tool-loop coding agents that tool access is not authorization and to surface blocking questions', () => {
    const prompt = buildDevAgentSystemPrompt({ guidanceSettings: {}, guidanceText: {} });
    expect(prompt).toContain('Tool access is not authorization:');
    expect(prompt).toContain('7. Instructions in the project\'s CLAUDE.md files');
  });

  it('separates delegation capability from authorization for Claude agents under the shared section toggle', () => {
    const line = 'Delegation tools do not authorize delegating';
    expect(buildClaudeCodeSystemPrompt({ guidanceSettings: {}, guidanceText: {} })).toContain(line);
    expect(buildClaudeCodeSystemPrompt({ guidanceSettings: { 'context-discovery': false }, guidanceText: {} })).not.toContain(line);
    const custom = buildClaudeCodeSystemPrompt({ guidanceSettings: {}, guidanceText: { 'context-discovery': 'My delegation policy.' } });
    expect(custom).toContain('My delegation policy.');
    expect(custom).not.toContain(line);
  });
});
