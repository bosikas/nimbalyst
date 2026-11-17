// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { setBuiltInGuidanceSettingsLoader } from '@nimbalyst/runtime/ai/builtInGuidance';
import { buildClaudeCodeSystemPrompt } from '@nimbalyst/runtime/ai/prompt';

const state = vi.hoisted(() => ({ settings: {} as Record<string, unknown>, handlers: new Map<string, (...args: any[]) => any>() }));
vi.mock('../../utils/store', () => ({
  getAppSetting: (key: string) => state.settings[key],
  setAppSetting: (key: string, value: unknown) => { state.settings[key] = value; },
  isTrackersAgentToolsEnabled: () => true,
}));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (channel: string, handler: (...args: any[]) => any) => { state.handlers.set(channel, handler); } }));
import { registerBuiltInGuidanceHandlers } from '../BuiltInGuidanceHandlers';

afterEach(() => { setBuiltInGuidanceSettingsLoader(); state.settings = {}; state.handlers.clear(); });

it('connects saved UI updates to future provider prompts and restores them on registration', () => {
  registerBuiltInGuidanceHandlers();
  expect(buildClaudeCodeSystemPrompt({})).toContain('developer_git_commit_proposal');
  state.handlers.get('agent-guidance:update')!(undefined, { 'git-commits': false });
  expect(state.settings.builtInGuidance).toEqual({ 'git-commits': false });
  expect(buildClaudeCodeSystemPrompt({})).not.toContain('developer_git_commit_proposal');
  registerBuiltInGuidanceHandlers();
  expect(state.handlers.get('agent-guidance:get-catalog')!().find((entry: { id: string }) => entry.id === 'git-commits').enabled).toBe(false);
  expect(buildClaudeCodeSystemPrompt({ sessionDirective: 'Keep my instructions.' })).toContain('Keep my instructions.');
  expect(() => state.handlers.get('agent-guidance:update')!(undefined, { identity: 'false' })).toThrow();
  expect(state.settings.builtInGuidance).toEqual({ 'git-commits': false });
});

it('connects editing and reset to persisted provider instructions and preview IPC', () => {
  registerBuiltInGuidanceHandlers();
  state.handlers.get('agent-guidance:update-text')!(undefined, 'identity', 'My agent identity.');
  expect(state.settings.builtInGuidanceText).toEqual({ identity: 'My agent identity.' });
  registerBuiltInGuidanceHandlers();
  expect(buildClaudeCodeSystemPrompt({})).toContain('My agent identity.');
  const preview = state.handlers.get('agent-guidance:preview')!(undefined, '/workspace', 'claude-code');
  expect(preview.text).toContain('My agent identity.');
  expect(() => state.handlers.get('agent-guidance:preview')!(undefined, '', 'claude-code')).toThrow();
  expect(() => state.handlers.get('agent-guidance:preview')!(undefined, '/workspace', 'invalid')).toThrow();
  state.handlers.get('agent-guidance:update-text')!(undefined, 'identity', null);
  expect(buildClaudeCodeSystemPrompt({})).not.toContain('My agent identity.');
  expect(state.settings.builtInGuidanceText).toEqual({});
});
