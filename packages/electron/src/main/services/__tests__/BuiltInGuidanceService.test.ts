// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { buildAgentGuidancePreview, buildBuiltInGuidanceCatalog, createBuiltInGuidanceService } from '../BuiltInGuidanceService';
import { BUILT_IN_GUIDANCE, setBuiltInGuidanceSettingsLoader } from '@nimbalyst/runtime/ai/builtInGuidance';
import { buildClaudeCodeSystemPrompt } from '@nimbalyst/runtime/ai/prompt';
import { buildCodexSystemPrompt } from '@nimbalyst/runtime/ai/server/providers/codex/codexSystemPrompt';

afterEach(() => setBuiltInGuidanceSettingsLoader());

it('previews every built-in section from its real builder, including the optional Codex reminder', () => {
  const catalog = buildBuiltInGuidanceCatalog({ 'git-commits': false });
  expect(catalog.map(({ id }) => id)).toEqual(BUILT_IN_GUIDANCE.map(({ id }) => id));
  for (const entry of catalog) {
    expect(entry.previews.length, entry.id).toBeGreaterThan(0);
    expect(entry.previews.every(({ text }) => text.trim().length > 0), entry.id).toBe(true);
  }
  expect(catalog.find(({ id }) => id === 'git-commits')).toMatchObject({ enabled: false });
  expect(catalog.find(({ id }) => id === 'session-naming-reminder')?.previews.some(({ text }) => text.includes('<SYSTEM_REMINDER>'))).toBe(true);
});

it('persists custom sections, preserves them across toggles, and restores provider defaults on reset', () => {
  let saved: unknown = {};
  let text: unknown = {};
  const storage = { read: () => saved, write: (value: unknown) => { saved = value; }, readText: () => text, writeText: (value: unknown) => { text = value; } };
  const service = createBuiltInGuidanceService(storage);
  setBuiltInGuidanceSettingsLoader(service.getSettings, service.getText);
  service.updateText('git-commits', 'Use my review process before committing.');
  service.updateText('worktree', 'Keep changes in the assigned worktree.');
  const options = { isMetaAgent: false, workflowPreset: 'default' as const, hasOutOfBandNaming: false, sessionDirective: 'Keep the human request.' };
  const codex = buildCodexSystemPrompt(options);
  expect(codex).toContain('Use my review process before committing.');
  expect(codex).not.toContain('developer_git_commit_proposal');
  expect(codex).not.toContain('Keep changes in the assigned worktree.');
  expect(codex).toContain('Keep the human request.');
  expect(buildClaudeCodeSystemPrompt({})).toContain('Use my review process before committing.');
  service.update({ 'git-commits': false });
  expect(buildCodexSystemPrompt(options)).not.toContain('Use my review process');
  expect(createBuiltInGuidanceService(storage).getCatalog().find(entry => entry.id === 'git-commits')).toMatchObject({ enabled: false, customText: 'Use my review process before committing.' });
  service.update({ 'git-commits': true });
  expect(buildCodexSystemPrompt(options)).toContain('Use my review process');
  service.updateText('git-commits', null);
  expect(buildCodexSystemPrompt(options)).toContain('developer_git_commit_proposal');
  expect(service.getCatalog().find(entry => entry.id === 'git-commits')?.customText).toBeUndefined();
});

it('rejects invalid text updates without writing, keeps the previous text on storage failures', () => {
  const writeText = vi.fn();
  const service = createBuiltInGuidanceService({ read: () => ({}), write: vi.fn(), readText: () => ({ identity: 'Saved identity.' }), writeText });
  for (const [id, text] of [['unknown', 'text'], ['identity', ''], ['identity', '  '], ['identity', 42], ['identity', 'a'.repeat(100_001)]]) {
    expect(() => service.updateText(id, text)).toThrow();
  }
  expect(writeText).not.toHaveBeenCalled();
  writeText.mockImplementation(() => { throw new Error('Disk full'); });
  expect(() => service.updateText('identity', 'New identity.')).toThrow('Disk full');
  expect(service.getText()).toEqual({ identity: 'Saved identity.' });
});

it('resolves saved controls through the provider builders and labels baseline scope', () => {
  const preview = buildAgentGuidancePreview('openai-codex', '/workspace', { 'git-commits': false }, { identity: 'Custom identity.' }, false);
  expect(preview.role).toBe('Developer instructions');
  expect(preview.text).toContain('Custom identity.');
  expect(preview.text).not.toContain('developer_git_commit_proposal');
  expect(preview.scope).toContain('Excludes provider-owned prompts');
  const claude = buildAgentGuidancePreview('claude-code', '/workspace', {}, { identity: 'Custom identity.' }, false);
  expect(claude.role).toBe('System prompt append');
  expect(claude.text).toContain('Custom identity.');
  expect(claude.text).not.toContain('## Tracker References');
  expect(() => buildAgentGuidancePreview('claude-code', '', {}, {}, false)).toThrow('workspace path');
});

it('persists controls across service recreation and changes future prompts without losing human instructions', () => {
  let saved: unknown = {};
  const storage = { read: () => saved, write: (value: unknown) => { saved = value; } };
  const service = createBuiltInGuidanceService(storage);
  setBuiltInGuidanceSettingsLoader(service.getSettings);
  const options = { isMetaAgent: false, workflowPreset: 'default' as const, hasOutOfBandNaming: false, sessionDirective: 'Keep the human request.' };
  const before = buildCodexSystemPrompt(options);
  expect(before).toContain('developer_git_commit_proposal');
  service.update(Object.fromEntries(BUILT_IN_GUIDANCE.map(({ id }) => [id, false])));
  const after = buildCodexSystemPrompt(options);
  expect(after).toContain(options.sessionDirective);
  expect(after).not.toContain('developer_git_commit_proposal');
  expect(after).not.toContain('PromptForUserInput');
  expect(buildClaudeCodeSystemPrompt({ hasSessionNaming: true, sessionDirective: options.sessionDirective })).toContain(options.sessionDirective);
  expect(createBuiltInGuidanceService(storage).getCatalog().every(({ enabled }) => !enabled)).toBe(true);
  console.log(`[guidance bytes] Codex default=${Buffer.byteLength(before)}; all optional guidance off=${Buffer.byteLength(after)}; human directive retained`);
});

it('ignores corrupt stored keys but rejects invalid updates before writing and reports storage failures', () => {
  const write = vi.fn();
  const service = createBuiltInGuidanceService({ read: () => ({ unknown: false, 'git-commits': false, identity: 'false' }), write });
  expect(service.getSettings()).toEqual({ 'git-commits': false });
  for (const update of [null, [], { unknown: false }, { identity: 'false' }]) {
    expect(() => service.update(update)).toThrow();
  }
  expect(write).not.toHaveBeenCalled();
  write.mockImplementation(() => { throw new Error('Disk full'); });
  expect(() => service.update({ identity: false })).toThrow('Disk full');
});
