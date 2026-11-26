// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureVibeWorktree } from '../ensureVibeWorktree';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  defaultRepo: vi.fn(),
  isRepo: vi.fn(),
  listWorktrees: vi.fn(),
  invoke: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: mocks.getSession },
}));
vi.mock('@nimbalyst/runtime/ai/server/ProviderFactory', () => ({
  ProviderFactory: { destroyProvider: mocks.destroy },
}));
vi.mock('../../../browserHost/browserPanelCommands', () => ({ invokeBrowserPanelCommand: mocks.invoke }));
vi.mock('../../../database/PGLiteDatabaseWorker', () => ({ database: {} }));
vi.mock('../../WorktreeStore', () => ({ createWorktreeStore: () => ({ list: mocks.listWorktrees }) }));
vi.mock('../../gitReadOnly', () => ({ simpleGitReadOnly: () => ({ checkIsRepo: mocks.isRepo }) }));
vi.mock('../../workspaceRepos', () => ({ resolveDefaultRepo: mocks.defaultRepo }));

const sender = {} as Electron.WebContents;
const workspacePath = '/project';
const worktree = { id: 'worktree', path: process.cwd(), projectPath: workspacePath };

describe('Vibe worktree before a turn', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getSession.mockResolvedValue({ workspacePath });
    mocks.isRepo.mockResolvedValue(true);
    mocks.listWorktrees.mockResolvedValue([]);
  });

  it('creates and persists a single worktree for concurrent first turns', async () => {
    mocks.invoke.mockImplementation(async (channel) => channel === 'worktree:create'
      ? { success: true, worktree }
      : { success: true });

    const first = ensureVibeWorktree('session', workspacePath, sender);
    const second = ensureVibeWorktree('session', workspacePath, sender);
    await expect(Promise.all([first, second])).resolves.toEqual([worktree, worktree]);
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(mocks.invoke).toHaveBeenLastCalledWith('sessions:update-metadata', sender, ['session', { worktreeId: worktree.id }]);
    expect(mocks.destroy).toHaveBeenCalledExactlyOnceWith('session', 'mistral-vibe');
  });

  it('reuses a saved worktree and refuses a missing checkout', async () => {
    mocks.getSession.mockResolvedValueOnce({ workspacePath, worktreeId: worktree.id, worktreePath: worktree.path });
    await expect(ensureVibeWorktree('session', workspacePath, sender)).resolves.toMatchObject({ path: worktree.path });
    mocks.getSession.mockResolvedValueOnce({ workspacePath, worktreeId: worktree.id });
    await expect(ensureVibeWorktree('session', workspacePath, sender)).rejects.toThrow('worktree');
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it('uses the workspace default repo and reuses the checkout after a failed attachment', async () => {
    const sourceRepo = '/project/repo';
    mocks.defaultRepo.mockReturnValue(sourceRepo);
    mocks.invoke
      .mockImplementationOnce(async (_channel, _sender, [, options]) => {
        mocks.listWorktrees.mockResolvedValue([{ ...worktree, name: options.name }]);
        return { success: true, worktree };
      })
      .mockResolvedValueOnce({ success: false, error: 'Attachment failed' })
      .mockResolvedValueOnce({ success: true });

    await expect(ensureVibeWorktree('session', workspacePath, sender)).rejects.toThrow('Attachment failed');
    await expect(ensureVibeWorktree('session', workspacePath, sender)).resolves.toMatchObject(worktree);
    expect(mocks.invoke).toHaveBeenCalledTimes(3);
    expect(mocks.invoke).toHaveBeenNthCalledWith(1, 'worktree:create', sender, [
      workspacePath, expect.objectContaining({ sourceFolderPath: sourceRepo }),
    ]);
    expect(mocks.destroy).toHaveBeenCalledExactlyOnceWith('session', 'mistral-vibe');
  });

  it('leaves non-Git projects usable and surfaces Git worktree failures', async () => {
    mocks.isRepo.mockResolvedValueOnce(false);
    await expect(ensureVibeWorktree('session', workspacePath, sender)).resolves.toBeUndefined();
    expect(mocks.invoke).not.toHaveBeenCalled();
    mocks.invoke.mockResolvedValueOnce({ success: false, error: 'Git rejected checkout' });
    await expect(ensureVibeWorktree('session', workspacePath, sender)).rejects.toThrow('Git rejected checkout');
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
