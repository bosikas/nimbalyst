// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildCodexSystemPrompt, type CodexSystemPromptOptions } from '../codexSystemPrompt';
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
      'display_to_user', 'capture_editor_screenshot', 'developer_git_commit_proposal',
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

  it('leaves meta-agent workflow instructions unchanged', () => {
    const input = { ...options, isMetaAgent: true, model: 'test-model', sessionDirective: 'Keep scope bounded.' };
    expect(buildCodexSystemPrompt(input)).toBe(buildMetaAgentSystemPrompt('codex', 'default', {
      provider: 'openai-codex', model: input.model, sessionDirective: input.sessionDirective,
    }));
  });
});
