// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { buildBuiltInGuidanceCatalog, createBuiltInGuidanceService } from '../BuiltInGuidanceService';
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
  expect(catalog.find(({ id }) => id === 'session-metadata')?.previews.some(({ text }) => text.includes('<SYSTEM_REMINDER>'))).toBe(true);
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
