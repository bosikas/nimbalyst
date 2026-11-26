import { randomUUID } from 'node:crypto';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { database } from '../database/PGLiteDatabaseWorker';
import { createWorktreeStore } from '../services/WorktreeStore';
import { findWindowByWorkspace } from '../window/WindowManager';
import { invokeBrowserPanelCommand, type BrowserPanelCommand } from './browserPanelCommands';

export async function invokeBrowserSessionHistory(
  workspacePath: string, channel: string, args: unknown[], defaultProvider: unknown,
) {
  const [first, second, third] = args;
  function invoke(command: BrowserPanelCommand, ...params: unknown[]) {
    const owner = findWindowByWorkspace(workspacePath);
    if (!owner || owner.isDestroyed()) throw new Error('Open this workspace on the Linux host to use its session controls');
    return invokeBrowserPanelCommand(command, owner.webContents, params);
  }

  async function requireSession(id: unknown) {
    if (typeof id !== 'string' || !id || id.length > 128) throw new Error('Invalid session ID');
    const session = await AISessionsRepository.get(id);
    if (session?.workspacePath !== workspacePath) throw new Error('Session not found in this workspace');
    return id;
  }

  switch (channel) {
    case 'sessions:search': {
      if (first !== workspacePath || typeof second !== 'string' || !second.trim() || second.length > 1000) {
        throw new Error('Invalid session search');
      }
      const options = third as { includeArchived?: unknown; timeRange?: unknown; direction?: unknown } | undefined;
      return invoke(channel, workspacePath, second.trim(), {
        includeArchived: options?.includeArchived === true,
        timeRange: options?.timeRange === '7d' || options?.timeRange === '30d' || options?.timeRange === '90d'
          ? options.timeRange : 'all',
        direction: options?.direction === 'input' || options?.direction === 'output' ? options.direction : 'all',
      });
    }
    case 'sessions:create': {
      const id = randomUUID();
      return invoke(channel, {
        workspaceId: workspacePath,
        session: { id, provider: defaultProvider, title: 'New Session' },
        launchSource: 'session_history',
      });
    }
    case 'sessions:update-title':
      if (typeof second !== 'string' || !second.trim() || second.length > 500) throw new Error('Invalid session title');
      return invoke(channel, await requireSession(first), second.trim());
    case 'sessions:update-pinned':
      if (typeof second !== 'boolean') throw new Error('Invalid pin change');
      return invoke(channel, await requireSession(first), second);
    case 'sessions:update-metadata': {
      const archived = (second as { isArchived?: unknown } | undefined)?.isArchived;
      if (typeof archived !== 'boolean') throw new Error('Invalid archive change');
      return invoke(channel, await requireSession(first), { isArchived: archived });
    }
    case 'sessions:list-children':
      if (second !== workspacePath) throw new Error('Invalid workspace');
      return invoke(channel, await requireSession(first), workspacePath, {
        includeArchived: (third as { includeArchived?: unknown } | undefined)?.includeArchived === true,
      });
    case 'worktree:get-batch': {
      if (!Array.isArray(first) || first.length > 500 || first.some((id) => typeof id !== 'string')) {
        throw new Error('Invalid worktree IDs');
      }
      const requested = new Set(first);
      const local = await createWorktreeStore(database).list(workspacePath);
      return invoke(channel, local.map(({ id }) => id).filter((id) => requested.has(id)));
    }
    default:
      throw new Error('This desktop command is unavailable in browser Sessions');
  }
}
