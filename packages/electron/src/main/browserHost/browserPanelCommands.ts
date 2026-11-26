import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { safeHandle } from '../utils/ipcRegistry';

export type BrowserPanelCommand =
  | 'sessions:list' | 'sessions:get' | 'sessions:create' | 'sessions:search' | 'sessions:list-children'
  | 'sessions:update-title' | 'sessions:update-metadata' | 'sessions:update-pinned'
  | 'sessions:create-child' | 'sessions:update-session-metadata'
  | 'ai-session-state:get-running' | 'ai-session-state:get-state'
  | 'ai:getModels' | 'ai:listPendingPrompts' | 'ai:createQueuedPrompt' | 'ai:triggerQueueProcessing'
  | 'ai:compactSession' | 'ai:deleteQueuedPrompt'
  | 'action-prompts:list'
  | 'worktree:list' | 'worktree:create' | 'worktree:archive' | 'worktree:get-batch' | 'worktree:update-pinned'
  | 'git:list-workspace-repos' | 'git:status' | 'git:branches' | 'git:log'
  | 'git:list-branches-detailed' | 'git:working-changes' | 'git:commit-detail' | 'git:file-diff';

type Handler = Parameters<typeof safeHandle>[1];
const commands = new Map<BrowserPanelCommand, Handler>();

/** Register a desktop operation with an explicit browser adapter. */
export function registerBrowserPanelCommand(channel: BrowserPanelCommand, handler: Handler): void {
  commands.set(channel, handler);
  safeHandle(channel, handler);
}

export async function invokeBrowserPanelCommand(channel: BrowserPanelCommand, sender: WebContents, args: unknown[]): Promise<unknown> {
  const handler = commands.get(channel);
  if (!handler) throw new Error('Desktop workspace service is unavailable');
  return handler({ sender, senderFrame: sender.mainFrame } as IpcMainInvokeEvent, ...args);
}
