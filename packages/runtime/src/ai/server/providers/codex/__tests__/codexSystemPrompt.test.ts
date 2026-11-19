// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodexSystemPrompt, CODEX_SESSION_NAMING_REMINDER_PROMPT, type CodexSystemPromptOptions } from '../codexSystemPrompt';
import { buildClaudeCodeSystemPrompt, buildMetaAgentSystemPrompt } from '../../../../prompt';
import { setPreferredAgentLanguage } from '../../../preferredAgentLanguageConfig';
import type { DocumentContext } from '../../../types';

const config = vi.hoisted(() => ({ naming: true, trackers: false }));
vi.mock('../../../services/mcpServerConfig', () => ({
  isInternalMcpServerEnabled: () => config.naming,
  areTrackerToolsEnabled: () => config.trackers,
  resolveTrackersWorkspacePath: () => '/workspace',
}));

const options: CodexSystemPromptOptions = {
  isMetaAgent: false,
  workflowPreset: 'default',
  hasOutOfBandNaming: false,
};

afterEach(() => {
  config.naming = true;
  config.trackers = false;
  setPreferredAgentLanguage(undefined);
});

describe('buildCodexSystemPrompt', () => {
  it('omits built-in identity and disabled summary while preserving Markdown replacements', () => {
    const markdown = '  My update_session_summary convention.\n\nKeep this paragraph.  ';
    const prompt = buildCodexSystemPrompt({
      ...options, generateSummary: false, guidanceText: { 'session-metadata': markdown },
    });
    expect(prompt).toContain(markdown);
    expect(prompt).not.toContain('Identify your actual AI model');
    expect(prompt.match(/update_session_summary/g)).toHaveLength(1);
    expect(buildCodexSystemPrompt({ ...options, generateSummary: false })).toContain('update_session_meta');
    expect(buildCodexSystemPrompt({ ...options, generateSummary: false })).not.toContain('update_session_summary');
    expect(buildCodexSystemPrompt(options)).toContain('update_session_summary');
  });
  it('distinguishes recommendations from questions and honors repository delivery/delegation rules', () => {
    const prompt = buildCodexSystemPrompt(options);
    expect(prompt).toContain('Findings and recommendations do not require a widget');
    expect(prompt).toContain('opening a widget does not end the task or grant approval');
    expect(prompt).toContain('Available delegation tools do not authorize delegation');
    expect(prompt).toContain('repository commit/review/release procedures');
    expect(prompt).not.toContain('developer_git_commit_proposal');
    expect(prompt).toContain('implementation alone does not authorize merge or deployment');
  });
  it('honors disabled commit and interactive guidance instead of unconditionally injecting it', () => {
    const input = {
      ...options,
      guidanceSettings: { 'git-commits': false, 'interactive-input': false },
      sessionDirective: 'Human request: keep the complete file list.',
    };
    const prompt = buildCodexSystemPrompt(input);
    expect(prompt).not.toContain('developer_git_commit_proposal');
    expect(prompt).not.toContain('PromptForUserInput');
    expect(prompt).toContain('native skill catalog and deferred tool discovery');
    expect(prompt).toContain(input.sessionDirective);
  });

  it('reduces ordinary startup size while retaining integration tool contracts', () => {
    const compact = buildCodexSystemPrompt(options);
    const previous = buildClaudeCodeSystemPrompt({
      hasSessionNaming: true, toolReferenceStyle: 'codex', trackersEnabled: false,
    });
    expect(compact.length).toBeLessThan(previous.length * 0.65);
    expect(compact).toContain("native skill catalog and deferred tool discovery");
    expect(compact).toContain('active constraints, decisions and ownership');
    expect(compact).toContain('not standing user requests');
    for (const tool of ['AskUserQuestion', 'PromptForUserInput', 'functions.wait',
      'display_to_user', 'capture_editor_screenshot',
      'update_session_meta']) {
      expect(compact).toContain(tool);
    }
    console.info(`Codex integration UTF-8 bytes: ${Buffer.byteLength(previous)} -> ${Buffer.byteLength(compact)}`);
  });

  it('preserves out-of-band names and applies the preferred language to new names', () => {
    setPreferredAgentLanguage('Lithuanian');
    expect(buildCodexSystemPrompt(options)).toContain('Use the preferred language: Lithuanian.');
    const named = buildCodexSystemPrompt({ ...options, hasOutOfBandNaming: true });
    expect(named).toContain('do not set name');
    expect(named).not.toContain('Also set name');
    expect(named).toContain('update_session_meta');
  });

  it('omits disabled integration sections and includes enabled trackers', () => {
    config.naming = false;
    const disabled = buildCodexSystemPrompt(options);
    expect(disabled).not.toContain('update_session_meta');
    expect(disabled).not.toContain('work_radar');
    config.trackers = true;
    expect(buildCodexSystemPrompt(options)).toContain('work_radar(issueKey)');
  });

  it('preserves worktree, voice customizations and the final session directive', () => {
    const documentContext = {
      worktreePath: '/workspace/owned', isVoiceMode: true,
      voiceModeCodingAgentPrompt: { prepend: 'CUSTOM VOICE BEFORE', append: 'CUSTOM VOICE AFTER' },
    } as DocumentContext;
    const prompt = buildCodexSystemPrompt({
      ...options, documentContext, sessionDirective: '  FINAL SESSION RULE  ',
    });
    expect(prompt).toContain('/workspace/owned');
    expect(prompt.indexOf('CUSTOM VOICE BEFORE')).toBeLessThan(prompt.indexOf('## Voice'));
    expect(prompt.indexOf('CUSTOM VOICE AFTER')).toBeGreaterThan(prompt.indexOf('## Voice'));
    expect(prompt).toMatch(/CUSTOM VOICE AFTER\n\nFINAL SESSION RULE\n<\/addendum>\n$/);
  });

  it('retains custom voice and human instructions when built-in voice guidance is disabled', () => {
    const documentContext = {
      isVoiceMode: true,
      voiceModeCodingAgentPrompt: { prepend: 'HUMAN VOICE BEFORE', append: 'HUMAN VOICE AFTER' },
    } as DocumentContext & { voiceModeCodingAgentPrompt: { prepend: string; append: string } };
    for (const prompt of [
      buildCodexSystemPrompt({ ...options, documentContext, guidanceSettings: { 'voice-mode': false }, sessionDirective: 'HUMAN TASK' }),
      buildClaudeCodeSystemPrompt({ isVoiceMode: true, voiceModeCodingAgentPrompt: documentContext.voiceModeCodingAgentPrompt, guidanceSettings: { 'voice-mode': false }, sessionDirective: 'HUMAN TASK' }),
    ]) {
      expect(prompt).not.toContain('## Voice');
      expect(prompt).toContain('HUMAN VOICE BEFORE');
      expect(prompt).toContain('HUMAN VOICE AFTER');
      expect(prompt).toContain('HUMAN TASK');
    }
  });

  it('leaves meta-agent workflow instructions unchanged', () => {
    const input = { ...options, isMetaAgent: true, model: 'test-model', sessionDirective: 'Keep scope bounded.' };
    expect(buildCodexSystemPrompt(input)).toBe(buildMetaAgentSystemPrompt('codex', 'default', {
      provider: 'openai-codex', model: input.model, sessionDirective: input.sessionDirective,
    }));
  });
});

it('does not tell a session whose name was assigned by its caller to set a name in the first-turn reminder', () => {
  expect(CODEX_SESSION_NAMING_REMINDER_PROMPT).not.toContain('set at least `name`');
  expect(CODEX_SESSION_NAMING_REMINDER_PROMPT).toContain('plus `name` unless the session name was already assigned for you');
  expect(CODEX_SESSION_NAMING_REMINDER_PROMPT).toContain('update_session_meta');
});
