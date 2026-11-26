import type { BrowserWorkspaceEvents } from '../../shared/browserHost';
import { isPathInWorkspace } from '../../shared/pathUtils';

const gitListeners = new Set<(path: string) => void>();

export function notifyBrowserGitChange(path: string): void {
  for (const listener of gitListeners) listener(path);
}

export function trackBrowserWorkspaceEvents(getFolders: () => string[]) {
  let gitRevision = 0;
  const onGitChange = (path: string) => {
    if (getFolders().some((folder) => isPathInWorkspace(path, folder))) gitRevision++;
  };
  gitListeners.add(onGitChange);
  return {
    read: (): BrowserWorkspaceEvents => ({ folders: getFolders(), gitRevision }),
    dispose: () => { gitListeners.delete(onGitChange); },
  };
}
