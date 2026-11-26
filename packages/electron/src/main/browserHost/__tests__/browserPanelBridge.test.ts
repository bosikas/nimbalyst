// @vitest-environment node
import { beforeEach, expect, it, vi } from 'vitest';
import { invokeBrowserPanel } from '../browserPanelBridge';
import { invokeBrowserSessionHistory } from '../browserSessionHistory';

const mocks = vi.hoisted(() => ({
  extension: vi.fn(),
  getSession: vi.fn(),
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

const dispatch = (channel: string, args: unknown[]) => invokeBrowserPanel('/workspace', 'archive', channel, args);
const sessionHistory = (channel: string, args: unknown[]) => invokeBrowserSessionHistory('/workspace', channel, args, 'codex');

it('runs native Sessions operations only against the connected workspace', async () => {
  mocks.getSession.mockResolvedValue({ workspacePath: '/other' });
  await expect(sessionHistory('sessions:update-title', ['other', 'Renamed'])).rejects.toThrow('Session not found');
  await expect(sessionHistory('sessions:search', ['/other', 'session'])).rejects.toThrow('Invalid session search');
  await expect(sessionHistory('extension:exec', ['command'])).rejects.toThrow('unavailable');
  expect(mocks.invoke).not.toHaveBeenCalled();

  mocks.getSession.mockResolvedValue({ workspacePath: '/workspace' });
  mocks.invoke.mockResolvedValue({ success: true });
  await sessionHistory('sessions:update-metadata', ['local', { isArchived: true, workspaceId: '/other' }]);
  expect(mocks.invoke).toHaveBeenCalledWith('sessions:update-metadata', mocks.sender, ['local', { isArchived: true }]);
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
