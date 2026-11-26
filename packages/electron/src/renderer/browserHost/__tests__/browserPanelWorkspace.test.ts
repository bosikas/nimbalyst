// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { createBrowserPanelWorkspace } from '../browserPanelWorkspace';

it('delivers workspace and Git changes to a mounted panel and supports unsubscribe', () => {
  const workspace = createBrowserPanelWorkspace('/workspace');
  const foldersChanged = vi.fn();
  const gitChanged = vi.fn();
  workspace.onWorkspaceEvent('workspace:folders-changed', foldersChanged);
  const unsubscribe = workspace.onWorkspaceEvent('git:status-changed', gitChanged);

  const snapshot = { folders: ['/workspace', '/attached'], gitRevision: 1 };
  workspace.update(snapshot);
  workspace.update({ ...snapshot, folders: [...snapshot.folders] });
  expect(workspace.getWorkspaceFolders()).toEqual(snapshot.folders);
  expect(foldersChanged).toHaveBeenCalledExactlyOnceWith({ workspacePath: '/workspace', folders: snapshot.folders });
  expect(gitChanged).toHaveBeenCalledExactlyOnceWith({ workspacePath: '/workspace' });

  unsubscribe();
  workspace.update({ ...snapshot, gitRevision: 2 });
  expect(gitChanged).toHaveBeenCalledTimes(1);
});
