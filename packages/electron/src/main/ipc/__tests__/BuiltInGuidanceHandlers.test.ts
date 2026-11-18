// @vitest-environment node
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { setBuiltInGuidanceSettingsLoader } from '@nimbalyst/runtime/ai/builtInGuidance';
import { loadCodexBaseInstructions, setCodexBaseInstructionsLoader } from '@nimbalyst/runtime/ai/codexBaseInstructions';
import { buildClaudeCodeSystemPrompt } from '@nimbalyst/runtime/ai/prompt';

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, handlers: new Map<string, (...args: any[]) => any>(), userData: '' }));
vi.mock('electron', () => ({ app: { getPath: () => state.userData } }));
vi.mock('../../utils/store', () => ({
  getAppSetting: (key: string) => state.settings[key],
  setAppSetting: (key: string, value: unknown) => { state.settings[key] = JSON.parse(JSON.stringify(value)); },
  isTrackersAgentToolsEnabled: () => true,
  store: { delete: (key: string) => { delete state.settings[key]; } },
}));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, handler: (...args: any[]) => any) => { state.handlers.set(channel, handler); } }));
import { registerBuiltInGuidanceHandlers } from '../BuiltInGuidanceHandlers';

const call = (channel: string, ...args: unknown[]) => state.handlers.get(channel)!(undefined, ...args);
const entry = (id: string) => call('agent-guidance:get-catalog').find((item: { id: string }) => item.id === id);
const sources = () => state.settings.agentGuidanceSources as { sections: Record<string, string>; codexBase?: string };
const guidanceDir = () => path.join(state.userData, 'agent-guidance');

beforeEach(() => { state.userData = mkdtempSync(path.join(tmpdir(), 'guidance-ipc-')); });
afterEach(() => {
  setBuiltInGuidanceSettingsLoader();
  setCodexBaseInstructionsLoader();
  rmSync(state.userData, { recursive: true, force: true });
  state.settings = {};
  state.handlers.clear();
});

it('connects saved toggles to future provider prompts and restores them on registration', () => {
  registerBuiltInGuidanceHandlers();
  expect(buildClaudeCodeSystemPrompt({})).toContain('developer_git_commit_proposal');
  call('agent-guidance:update', { 'git-commits': false });
  expect(state.settings.builtInGuidance).toEqual({ 'git-commits': false });
  expect(buildClaudeCodeSystemPrompt({})).not.toContain('developer_git_commit_proposal');
  registerBuiltInGuidanceHandlers();
  expect(entry('git-commits').enabled).toBe(false);
  expect(buildClaudeCodeSystemPrompt({ sessionDirective: 'Keep my instructions.' })).toContain('Keep my instructions.');
  expect(() => call('agent-guidance:update', { identity: 'false' })).toThrow();
  expect(state.settings.builtInGuidance).toEqual({ 'git-commits': false });
});

it('migrates legacy settings prose into Markdown files byte-for-byte with a recoverable backup', () => {
  const legacy = { identity: '  Agent identity.\r\n\tÜnïcode 🙂 kept\n\n', bogus: 'unknown section' };
  state.settings.builtInGuidanceText = legacy;
  registerBuiltInGuidanceHandlers();
  const file = sources().sections.identity;
  expect(path.dirname(file)).toBe(guidanceDir());
  expect(readFileSync(file, 'utf8')).toBe(legacy.identity);
  expect(state.settings.builtInGuidanceText).toBeUndefined();
  const backups = readdirSync(path.join(guidanceDir(), 'legacy-backups'));
  expect(JSON.parse(readFileSync(path.join(guidanceDir(), 'legacy-backups', backups[0]), 'utf8'))).toEqual(legacy);
  expect(buildClaudeCodeSystemPrompt({})).toContain(legacy.identity);
  expect(entry('identity')).toMatchObject({ customText: legacy.identity, sourcePath: file });
  registerBuiltInGuidanceHandlers();
  expect(sources().sections.identity).toBe(file);
});

it('keeps legacy prose applied and in settings when migration cannot write files', () => {
  writeFileSync(path.join(state.userData, 'agent-guidance'), 'not a directory');
  state.settings.builtInGuidanceText = { identity: 'Legacy identity.' };
  vi.spyOn(console, 'error').mockImplementation(() => {});
  registerBuiltInGuidanceHandlers();
  expect(state.settings.builtInGuidanceText).toEqual({ identity: 'Legacy identity.' });
  expect(buildClaudeCodeSystemPrompt({})).toContain('Legacy identity.');
});

it('saves immutable versions, reads external edits, and fails prompts instead of falling back when the file is gone', () => {
  registerBuiltInGuidanceHandlers();
  call('agent-guidance:update-text', 'identity', 'First identity.');
  const first = sources().sections.identity;
  expect(state.settings.builtInGuidanceText).toBeUndefined();
  call('agent-guidance:update-text', 'identity', 'Second identity.');
  const second = sources().sections.identity;
  expect(second).not.toBe(first);
  expect(readFileSync(first, 'utf8')).toBe('First identity.');
  writeFileSync(second, 'Edited outside Nimbalyst.');
  expect(buildClaudeCodeSystemPrompt({})).toContain('Edited outside Nimbalyst.');
  expect(call('agent-guidance:preview', '/workspace', 'claude-code').text).toContain('Edited outside Nimbalyst.');
  expect(entry('identity')).toMatchObject({ customText: 'Edited outside Nimbalyst.', sourcePath: second });
  unlinkSync(second);
  expect(() => buildClaudeCodeSystemPrompt({})).toThrow('Editor identity');
  expect(() => call('agent-guidance:preview', '/workspace', 'claude-code')).toThrow('could not be loaded');
  expect(entry('identity').sourceError).toContain(second);
  call('agent-guidance:update', { identity: false });
  expect(() => buildClaudeCodeSystemPrompt({})).not.toThrow();
  call('agent-guidance:update', { identity: true });
  call('agent-guidance:update-text', 'identity', null);
  expect(sources().sections.identity).toBeUndefined();
  expect(existsSync(first)).toBe(true);
  expect(buildClaudeCodeSystemPrompt({})).not.toContain('First identity.');
  expect(() => call('agent-guidance:preview', '', 'claude-code')).toThrow();
  expect(() => call('agent-guidance:preview', '/workspace', 'invalid')).toThrow();
});

it('selects only bounded UTF-8 regular Markdown files and keeps the previous source on rejection', () => {
  registerBuiltInGuidanceHandlers();
  const dir = state.userData;
  const good = path.join(dir, 'mine.md');
  writeFileSync(good, '# My commits\nUse my process.');
  call('agent-guidance:select-source', 'git-commits', good);
  expect(entry('git-commits')).toMatchObject({ sourcePath: good, customText: '# My commits\nUse my process.' });
  const rejects: Array<[string, string | Buffer | null]> = [
    [path.join(dir, 'notes.txt'), 'text'],
    [path.join(dir, 'missing.md'), null],
    [path.join(dir, 'empty.md'), '  \n'],
    [path.join(dir, 'binary.md'), Buffer.from([0x66, 0x00, 0x6f])],
    [path.join(dir, 'latin1.md'), Buffer.from([0xe9, 0x74, 0xe9])],
    [path.join(dir, 'huge.md'), 'a'.repeat(512 * 1024 + 1)],
  ];
  for (const [file, content] of rejects) {
    if (content !== null) writeFileSync(file, content);
    expect(() => call('agent-guidance:select-source', 'git-commits', file), file).toThrow();
  }
  expect(() => call('agent-guidance:select-source', 'git-commits', 'relative.md')).toThrow('absolute');
  expect(() => call('agent-guidance:select-source', 'unknown', good)).toThrow();
  expect(sources().sections['git-commits']).toBe(good);
  expect(buildClaudeCodeSystemPrompt({})).toContain('Use my process.');
});

it('installs a Codex base loader: provider default when unset, file-backed when set, error when unreadable', () => {
  registerBuiltInGuidanceHandlers();
  expect(loadCodexBaseInstructions()).toBeUndefined();
  expect(call('agent-guidance:get-codex-base')).toEqual({});
  expect(call('agent-guidance:preview', '/workspace', 'openai-codex').baseInstructions).toBeUndefined();
  expect(() => call('agent-guidance:update-codex-base', '   ')).toThrow();
  const saved = call('agent-guidance:update-codex-base', 'You are my Codex base.');
  expect(saved).toMatchObject({ text: 'You are my Codex base.' });
  expect(loadCodexBaseInstructions()).toBe('You are my Codex base.');
  expect(call('agent-guidance:preview', '/workspace', 'openai-codex').baseInstructions).toMatchObject({ sourcePath: saved.sourcePath, text: 'You are my Codex base.' });
  expect(call('agent-guidance:preview', '/workspace', 'claude-code').baseInstructions).toBeUndefined();
  writeFileSync(saved.sourcePath, 'Edited base.');
  expect(loadCodexBaseInstructions()).toBe('Edited base.');
  unlinkSync(saved.sourcePath);
  expect(() => loadCodexBaseInstructions()).toThrow('Codex base instructions could not be loaded');
  expect(call('agent-guidance:get-codex-base').error).toContain(saved.sourcePath);
  expect(() => call('agent-guidance:select-codex-base-source', path.join(state.userData, 'none.md'))).toThrow();
  expect(sources().codexBase).toBe(saved.sourcePath);
  const external = path.join(state.userData, 'base.md');
  writeFileSync(external, 'External base.');
  call('agent-guidance:select-codex-base-source', external);
  expect(loadCodexBaseInstructions()).toBe('External base.');
  expect(call('agent-guidance:update-codex-base', null)).toEqual({});
  expect(loadCodexBaseInstructions()).toBeUndefined();
  expect(readFileSync(external, 'utf8')).toBe('External base.');
});
