import type { PanelHost } from '@nimbalyst/extension-sdk';
import type { BrowserWorkspaceEvents } from '../../shared/browserHost';

export function createBrowserPanelWorkspace(workspacePath: string) {
  let folders = [workspacePath];
  let gitRevision = 0;
  const events = {
    'workspace:folders-changed': new Set<(data: unknown) => void>(),
    'git:status-changed': new Set<(data: unknown) => void>(),
  };

  const onWorkspaceEvent: PanelHost['onWorkspaceEvent'] = (event, callback) => {
    if (event !== 'workspace:folders-changed' && event !== 'git:status-changed') return () => {};
    const callbacks = events[event];
    callbacks.add(callback);
    return () => { callbacks.delete(callback); };
  };

  function update(next: BrowserWorkspaceEvents) {
    const foldersChanged = folders.length !== next.folders.length ||
      folders.some((path, index) => path !== next.folders[index]);
    const gitChanged = next.gitRevision !== gitRevision;
    folders = next.folders;
    gitRevision = next.gitRevision;
    if (foldersChanged) {
      for (const callback of events['workspace:folders-changed']) callback({ workspacePath, folders: [...folders] });
    }
    if (gitChanged) {
      for (const callback of events['git:status-changed']) callback({ workspacePath });
    }
  }

  return { getWorkspaceFolders: () => [...folders], onWorkspaceEvent, update };
}
