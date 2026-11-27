// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { createBrowserHostHandler, type BrowserHostServices } from '../browserHost';
import { invokeBrowserPanel } from '../browserPanelBridge';
import { invokeBrowserSessionHistory } from '../browserSessionHistory';

const mocks = vi.hoisted(() => ({
  extension: vi.fn(),
  getSession: vi.fn(),
  getViewMessages: vi.fn(),
  inspectContext: vi.fn(),
  listSessions: vi.fn(),
  invoke: vi.fn(),
  query: vi.fn(),
  getWorktree: vi.fn(),
  callTool: vi.fn(),
  findWindow: vi.fn(),
  getWorkspaceState: vi.fn(),
  updateWorkspaceState: vi.fn(),
  getAppSetting: vi.fn(),
  setAppSetting: vi.fn(),
  sender: {},
}));
vi.mock('../browserPanels', () => ({
  callBrowserPanelTool: mocks.callTool,
  findPanelExtension: mocks.extension,
}));
vi.mock('../browserPanelCommands', () => ({ invokeBrowserPanelCommand: mocks.invoke }));
vi.mock('../../window/WindowManager', () => ({ findWindowByWorkspace: mocks.findWindow }));
vi.mock('../../mcp/sessionContextInspection', () => ({ getSessionContextInspection: mocks.inspectContext }));
vi.mock('../../utils/store', () => ({
  getAppSetting: mocks.getAppSetting,
  getWorkspaceState: mocks.getWorkspaceState,
  setAppSetting: mocks.setAppSetting,
  updateWorkspaceState: mocks.updateWorkspaceState,
}));
vi.mock('../../database/PGLiteDatabaseWorker', () => ({
  database: { getEngine: () => 'sqlite', queryReadOnly: mocks.query },
}));
vi.mock('../../services/WorktreeStore', () => ({
  createWorktreeStore: () => ({ get: mocks.getWorktree }),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: mocks.getSession, list: mocks.listSessions },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/TranscriptMigrationRepository', () => ({
  TranscriptMigrationRepository: { getService: () => ({ getViewMessages: mocks.getViewMessages }) },
}));

const dispatch = (channel: string, args: unknown[]) => invokeBrowserPanel('/workspace', 'archive', channel, args);
const sessionHistory = (channel: string, args: unknown[]) => invokeBrowserSessionHistory('/workspace', channel, args, 'codex');

function postSessionCommand(channel: string, payload: object, authenticated = true) {
  const handle = createBrowserHostHandler({ token: 'test-token', workspacePath: '/workspace', rendererPath: '/renderer' }, {
    invokeSessionHistory: sessionHistory,
  } as BrowserHostServices);
  return handle(new Request('http://127.0.0.1/api/session-history/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: 'Bearer test-token' } : {}) },
    body: JSON.stringify({ channel, args: [payload] }),
  }));
}

it.each(['answer-question', 'cancel-question'])('dispatches browser %s only for a pending question in the connected workspace', async (action) => {
  const channel = `claude-code:${action}`;
  const input = { sessionId: 'local', questionId: 'question-1',
    ...(action === 'answer-question' ? { answers: { 'Pick one': 'A' } } : {}) };
  const post = (payload: object, authenticated?: boolean) => postSessionCommand(channel, payload, authenticated);
  expect((await post(input, false)).status).toBe(401);
  expect(mocks.getSession).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValueOnce({ workspacePath: '/outside' });
  expect(await (await post(input)).json()).toEqual({ error: 'Session not found in this workspace' });
  expect(mocks.getViewMessages).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace', provider: 'claude-code' });
  const toolCall = { providerToolCallId: input.questionId, toolName: 'mcp__nimbalyst__AskUserQuestion' };
  mocks.getViewMessages.mockResolvedValueOnce([{ type: 'tool_call', toolCall: { ...toolCall, result: 'Already answered' } }]);
  expect(await (await post(input)).json()).toEqual({ error: 'Question is no longer pending' });
  expect(mocks.invoke).not.toHaveBeenCalled();

  mocks.getViewMessages.mockResolvedValue([{ type: 'tool_call', toolCall }]);
  if (action === 'answer-question') {
    const malformed = await post({ ...input, answers: { 'Pick one': true } });
    expect(await malformed.json()).toEqual({ error: 'Invalid question answers' });
    expect(mocks.invoke).not.toHaveBeenCalled();
  }
  mocks.invoke.mockResolvedValue({ success: true });
  const response = await post(input);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ result: { success: true } });
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(channel, mocks.sender, [input]);
});

it.each(['claude-code', 'openai-codex', 'mistral-vibe'])('submits and cancels %s structured forms through the browser', async (provider) => {
  const channel = 'messages:respond-to-prompt';
  const input = { sessionId: 'local', promptId: 'form-1', promptType: 'request_user_input_request' };
  const tool = { providerToolCallId: input.promptId, toolName: 'mcp__nimbalyst__PromptForUserInput' };
  const answers = {
    choices: { type: 'multiSelect', selectedIds: ['a', 'b'] },
    choice: { type: 'singleSelect', selectedId: '__other__', otherText: 'Different' },
    order: { type: 'reorder', orderedIds: ['b'], removedIds: ['a'] },
    draft: { type: 'editText', text: 'Edited\ntext', edited: true },
    accept: { type: 'confirm', value: false },
  };
  const form = { ...input, response: { answers, cancelled: false } };
  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace', provider });
  mocks.getViewMessages.mockResolvedValue([{ type: 'tool_call', toolCall: tool }]);
  mocks.invoke.mockResolvedValue({ success: true });

  const submitted = await postSessionCommand(channel, form);
  expect(submitted.status).toBe(200);
  expect(await submitted.json()).toEqual({ result: { success: true } });
  expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith(channel, mocks.sender, [{ ...form, respondedBy: 'desktop' }]);

  const cancelled = { ...input, response: { answers: {}, cancelled: true } };
  mocks.getViewMessages.mockResolvedValue([{ type: 'tool_call', toolCall: { ...tool, toolName: 'RequestUserInput' } }]);
  expect((await postSessionCommand(channel, cancelled)).status).toBe(200);
  expect(mocks.invoke).toHaveBeenLastCalledWith(channel, mocks.sender, [{ ...cancelled, respondedBy: 'desktop' }]);
});

it('rejects browser form replies outside the connected session’s pending forms', async () => {
  const channel = 'messages:respond-to-prompt';
  const input = { sessionId: 'local', promptId: 'form-1', promptType: 'request_user_input_request',
    response: { answers: {}, cancelled: true } };
  expect((await postSessionCommand(channel, input, false)).status).toBe(401);
  expect((await postSessionCommand(channel, { ...input, promptType: 'git_commit_proposal_request' })).status).toBe(400);
  expect((await postSessionCommand(channel, { ...input, response: { answers: { a: { type: 'confirm', value: 'yes' } }, cancelled: false } })).status).toBe(400);
  expect(mocks.getSession).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValueOnce({ workspacePath: '/outside' });
  expect(await (await postSessionCommand(channel, input)).json()).toEqual({ error: 'Session not found in this workspace' });
  expect(mocks.getViewMessages).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace', provider: 'openai-codex' });
  mocks.getViewMessages.mockResolvedValueOnce([{ type: 'tool_call', toolCall: { providerToolCallId: input.promptId, toolName: 'AskUserQuestion' } }]);
  expect(await (await postSessionCommand(channel, input)).json()).toEqual({ error: 'Question is no longer pending' });
  mocks.getViewMessages.mockResolvedValueOnce([{ type: 'tool_call', toolCall: {
    providerToolCallId: input.promptId, toolName: 'PromptForUserInput', result: 'Already answered',
  } }]);
  expect(await (await postSessionCommand(channel, input)).json()).toEqual({ error: 'Question is no longer pending' });
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('limits browser steering requests to the connected workspace', async () => {
  const channel = 'ai:sendQueuedVibePromptNow';
  mocks.getSession.mockResolvedValueOnce({ workspacePath: '/other' });
  await expect(sessionHistory(channel, ['foreign', 'queued'])).rejects.toThrow('Session not found');
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.getSession.mockResolvedValueOnce({ workspacePath: '/workspace' });
  await sessionHistory(channel, ['local', 'queued']);
  expect(mocks.invoke).toHaveBeenCalledWith(channel, mocks.sender, ['local', 'queued']);
});

  it('requests user-facing context evidence only for the connected workspace', async () => {
  const channel = 'mcp-config:get-context-inspection';
  mocks.getSession.mockResolvedValue({ workspacePath: '/other' });
  await expect(sessionHistory(channel, ['outside'])).rejects.toThrow('Session not found');
  expect(mocks.inspectContext).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace' });
  const inspection = { preparedRequest: { categories: [{ name: 'Prompt', bytes: 512 }] } };
  mocks.inspectContext.mockResolvedValue(inspection);
  await expect(sessionHistory(channel, ['local'])).resolves.toEqual(inspection);
    expect(mocks.inspectContext).toHaveBeenCalledWith('local', '/workspace', { audience: 'browser' });
});

it('runs native Sessions operations only against the connected workspace', async () => {
  mocks.getSession.mockResolvedValue({ workspacePath: '/other' });
  await expect(sessionHistory('sessions:update-title', ['other', 'Renamed'])).rejects.toThrow('Session not found');
  await expect(sessionHistory('sessions:search', ['/other', 'session'])).rejects.toThrow('Invalid session search');
  await expect(sessionHistory('extension:exec', ['command'])).rejects.toThrow('unavailable');
  expect(mocks.invoke).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace' });
  mocks.invoke.mockResolvedValue({ success: true });
  await sessionHistory('sessions:update-metadata', ['local', { title: '  Renamed  ', isArchived: true, workspaceId: '/other' }]);
  expect(mocks.invoke).toHaveBeenCalledWith('sessions:update-metadata', mocks.sender, ['local', { title: 'Renamed', isArchived: true }]);
});

it('creates a child with the host defaults only for a parent in the connected workspace', async () => {
  mocks.getSession.mockResolvedValueOnce({ workspacePath: '/other' });
  await expect(sessionHistory('sessions:create-child', ['parent'])).rejects.toThrow('Session not found');
  expect(mocks.invoke).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace' });
  await sessionHistory('sessions:create-child', ['parent', { workspacePath: '/other', provider: 'claude-code' }]);
  expect(mocks.invoke).toHaveBeenCalledWith('sessions:create-child', mocks.sender, [{
    parentSessionId: 'parent', workspacePath: '/workspace', provider: 'codex',
  }]);
});

it('forwards validated header tag and worktree pin changes only inside the workspace', async () => {
  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace' });
  await expect(sessionHistory('sessions:update-session-metadata', ['local', { tags: [42] }]))
    .rejects.toThrow('Invalid session tags');
  await sessionHistory('sessions:update-session-metadata', ['local', { tags: ['parity'], phase: 'complete' }]);
  expect(mocks.invoke).toHaveBeenCalledWith('sessions:update-session-metadata', mocks.sender, ['local', { tags: ['parity'] }]);

  mocks.getWorktree.mockResolvedValueOnce({ projectPath: '/other' });
  await expect(sessionHistory('worktree:update-pinned', ['worktree', true])).rejects.toThrow('Worktree not found');
  mocks.getWorktree.mockResolvedValueOnce({ projectPath: '/workspace' });
  await sessionHistory('worktree:update-pinned', ['worktree', true]);
  expect(mocks.invoke).toHaveBeenCalledWith('worktree:update-pinned', mocks.sender, ['worktree', true]);
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.extension.mockResolvedValue({ manifest: { permissions: { catalog: ['nimbalyst-database-read'] } } });
  mocks.findWindow.mockReturnValue({ isDestroyed: () => false, webContents: mocks.sender });
});

it('rejects unmatched workspaces, foreign session IDs and unmapped desktop IPC', async () => {
  mocks.getSession.mockResolvedValue({ workspacePath: '/other' });
  await expect(dispatch('sessions:list', ['/other'])).rejects.toThrow('workspace denied');
  await expect(dispatch('ai:createQueuedPrompt', ['foreign', 'prompt'])).rejects.toThrow('Session not found');
  await expect(dispatch('filesystem:readFile', ['/other/private'])).rejects.toThrow('unavailable');
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it('uses native archive validation with the configured workspace and only the requested archive state', async () => {
  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace' });
  mocks.invoke.mockResolvedValue({ success: true });
  await expect(dispatch('sessions:update-metadata', ['local', { isArchived: true, provider: 'other' }]))
    .resolves.toEqual({ success: true });
  expect(mocks.invoke).toHaveBeenCalledWith('sessions:update-metadata', mocks.sender, ['local', { isArchived: true }]);
  mocks.getWorktree.mockResolvedValue({ projectPath: '/other' });
  await expect(dispatch('worktree:archive', ['foreign', '/workspace'])).rejects.toThrow('Worktree not found');
});

it('requires catalog access and executes the workspace projection for a permitted database read', async () => {
  const args = [{ sql: 'SELECT id FROM ai_sessions WHERE id = $1', params: ['local'] }];
  mocks.extension.mockResolvedValueOnce({ manifest: {} });
  await expect(dispatch('extension:database:query', args)).rejects.toThrow('no database read permission');
  expect(mocks.query).not.toHaveBeenCalled();
  mocks.query.mockResolvedValue({ rows: [{ id: 'local' }] });
  await expect(dispatch('extension:database:query', args)).resolves.toEqual({ rows: [{ id: 'local' }] });
  expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining('workspace_id = $2'), ['local', '/workspace']);
});

it('shares only the active panel’s namespace for desktop preferences', async () => {
  const state = { extensionStorage: { 'ext:archive:layout': 'compact', 'ext:workoverview:layout': 'wide' } };
  mocks.getWorkspaceState.mockReturnValue(state);
  mocks.getAppSetting.mockReturnValue({ 'ext:archive:density': 'small', 'ext:workoverview:density': 'large' });
  mocks.updateWorkspaceState.mockImplementationOnce((_workspace, update) => update(state));
  await expect(dispatch('extension:storage:get', [])).resolves.toEqual({
    workspace: { layout: 'compact' }, global: { density: 'small' },
  });
  await dispatch('extension:storage:set', [{ scope: 'workspace', key: 'layout', value: 'wide' }]);
  expect(state.extensionStorage).toEqual({ 'ext:archive:layout': 'wide', 'ext:workoverview:layout': 'wide' });
});
