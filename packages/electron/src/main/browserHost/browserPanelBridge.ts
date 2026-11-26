import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { database } from '../database/PGLiteDatabaseWorker';
import { findWindowByWorkspace } from '../window/WindowManager';
import { createWorktreeStore } from '../services/WorktreeStore';
import { getAppSetting, getWorkspaceRoots, getWorkspaceState, setAppSetting, updateWorkspaceState } from '../utils/store';
import { callBrowserPanelTool, findPanelExtension } from './browserPanels';
import { scopeBrowserExtensionQuery } from './browserExtensionQuery';
import { invokeBrowserPanelCommand, type BrowserPanelCommand } from './browserPanelCommands';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid extension arguments');
  return value as Record<string, unknown>;
}

function string(value: unknown, max = 32000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('Invalid extension argument');
  return value;
}

function inside(root: string, path: string): boolean {
  const subpath = relative(root, path);
  return !isAbsolute(subpath) && subpath !== '..' && !subpath.startsWith(`..${sep}`);
}

/** Browser panels can reuse specific desktop operations scoped to their host workspace. */
export async function invokeBrowserPanel(workspacePath: string, extensionId: string, channel: string, args: unknown[]) {
  const extension = await findPanelExtension(extensionId);
  if (!extension) throw new Error('Extension panel is unavailable');
  const [first, second] = args;
  const storagePrefix = `ext:${extensionId}:`;
  const globalStorage = () => (getAppSetting('extensionStorage') as Record<string, unknown> | undefined) ?? {};
  const scopedStorage = (storage: Record<string, unknown> | undefined) => Object.fromEntries(
    Object.entries(storage ?? {}).filter(([key]) => key.startsWith(storagePrefix))
      .map(([key, value]) => [key.slice(storagePrefix.length), value]),
  );

  function assertWorkspace(path: unknown): void {
    if (path !== workspacePath) throw new Error('Browser extension workspace denied');
  }

  async function requireSession(value: unknown) {
    const id = string(value, 128);
    const session = await AISessionsRepository.get(id);
    if (session?.workspacePath !== workspacePath) throw new Error('Session not found in this workspace');
    return id;
  }

  async function invoke(command: BrowserPanelCommand, scopedArgs: unknown[] = []) {
    const owner = findWindowByWorkspace(workspacePath);
    if (!owner || owner.isDestroyed()) throw new Error('Open this workspace on the host to use its extension controls');
    return invokeBrowserPanelCommand(command, owner.webContents, scopedArgs);
  }

  async function requireRepo(value: unknown) {
    const path = await realpath(string(value, 4096));
    const roots = getWorkspaceRoots(workspacePath);
    const worktrees = await createWorktreeStore(database).list(workspacePath);
    const allowed = await Promise.all([...roots, ...worktrees.map(({ path }) => path)]
      .map((root) => realpath(root).catch(() => null)));
    if (!allowed.some((root) => root && inside(root, path))) throw new Error('Repository not found in this workspace');
    return path;
  }

  switch (channel) {
    case 'extension:storage:get':
      return { workspace: scopedStorage(getWorkspaceState(workspacePath).extensionStorage), global: scopedStorage(globalStorage()) };
    case 'extension:storage:set': {
      const input = record(first);
      const key = storagePrefix + string(input.key, 200);
      function apply(storage: Record<string, unknown>): void {
        if (input.delete === true) delete storage[key];
        else storage[key] = input.value;
      }
      if (input.scope === 'global') {
        const storage = { ...globalStorage() };
        apply(storage);
        setAppSetting('extensionStorage', storage);
      } else if (input.scope === 'workspace') {
        updateWorkspaceState(workspacePath, (state) => { apply(state.extensionStorage ??= {}); });
      } else {
        throw new Error('Invalid extension storage scope');
      }
      return;
    }
    case 'extension:database:query': {
      const input = record(first);
      const permissions = extension.manifest.permissions;
      if (!permissions?.catalog?.includes('nimbalyst-database-read')) throw new Error('Extension has no database read permission');
      const params = input.params ?? [];
      if (!Array.isArray(params)) throw new Error('Invalid database parameters');
      const query = scopeBrowserExtensionQuery(string(input.sql), params, workspacePath, database.getEngine());
      const result = await database.queryReadOnly(query.sql, query.params);
      return { rows: result.rows };
    }
    case 'extensions:ai-call-backend-tool': {
      const input = record(first);
      assertWorkspace(input.workspacePath);
      return callBrowserPanelTool(workspacePath, extensionId, string(input.toolName, 160), record(input.args ?? {}));
    }
    case 'sessions:list':
      assertWorkspace(first);
      return invoke(channel, [workspacePath, { includeArchived: record(second ?? {}).includeArchived === true }]);
    case 'sessions:get':
    case 'ai-session-state:get-state':
    case 'ai:listPendingPrompts':
      return invoke(channel, [await requireSession(first)]);
    case 'ai-session-state:get-running': {
      const result = record(await invoke(channel));
      const ids = Array.isArray(result.sessionIds) ? result.sessionIds : [];
      const local = new Set((await AISessionsRepository.list(workspacePath, { includeArchived: true })).map(({ id }) => id));
      return { ...result, sessionIds: ids.filter((id) => local.has(id)) };
    }
    case 'ai:getModels':
      return invoke(channel);
    case 'ai:createQueuedPrompt':
    case 'sessions:update-title':
      return invoke(channel, [await requireSession(first), string(second)]);
    case 'ai:triggerQueueProcessing':
      assertWorkspace(second);
      return invoke(channel, [await requireSession(first), workspacePath]);
    case 'sessions:update-metadata': {
      const update = record(second);
      if (typeof update.isArchived !== 'boolean') throw new Error('Invalid archive change');
      return invoke(channel, [await requireSession(first), { isArchived: update.isArchived }]);
    }
    case 'sessions:create': {
      const input = record(first);
      assertWorkspace(input.workspaceId);
      const session = record(input.session);
      const id = string(session.id, 128);
      if (await AISessionsRepository.get(id)) throw new Error('Session already exists');
      const parentSessionId = session.parentSessionId ? await requireSession(session.parentSessionId) : null;
      const metadata = record(session.metadata ?? {});
      return invoke(channel, [{
        workspaceId: workspacePath,
        session: {
          id,
          provider: string(session.provider, 80),
          model: string(session.model, 160),
          title: string(session.title, 500),
          parentSessionId,
          metadata: {
            effortLevel: metadata.effortLevel,
            toolScope: metadata.toolScope,
            generateSummary: metadata.generateSummary,
            autoArchiveAfterMinutes: metadata.autoArchiveAfterMinutes,
            hasBeenNamed: metadata.hasBeenNamed,
          },
        },
      }]);
    }
    case 'worktree:list':
      assertWorkspace(first);
      return invoke(channel, [workspacePath]);
    case 'worktree:create': {
      assertWorkspace(first);
      const options = record(second ?? {});
      return invoke(channel, [workspacePath, { name: string(options.name, 128) }]);
    }
    case 'worktree:archive': {
      assertWorkspace(second);
      const id = string(first, 128);
      const worktree = await createWorktreeStore(database).get(id);
      if (worktree?.projectPath !== workspacePath) throw new Error('Worktree not found in this workspace');
      return invoke(channel, [id, workspacePath]);
    }
    case 'git:list-workspace-repos':
      assertWorkspace(first);
      return invoke(channel, [workspacePath]);
    case 'git:status':
    case 'git:branches':
    case 'git:list-branches-detailed':
    case 'git:working-changes':
      return invoke(channel, [await requireRepo(first)]);
    case 'git:log': {
      const options = record(args[2] ?? {});
      const branch = options.branch === undefined ? undefined : string(options.branch, 200);
      if (branch && (branch.startsWith('-') || !/^[\w./-]+$/.test(branch))) throw new Error('Invalid Git branch');
      const limit = Number.isInteger(second) ? Math.max(1, Math.min(Number(second), 500)) : 100;
      return invoke(channel, [await requireRepo(first), limit, { branch, aheadBehind: options.aheadBehind === true }]);
    }
    case 'git:commit-detail': {
      const hash = string(second, 64);
      if (!/^[a-f0-9]{7,64}$/i.test(hash)) throw new Error('Invalid Git commit');
      return invoke(channel, [await requireRepo(first), hash]);
    }
    case 'git:file-diff': {
      const repo = await requireRepo(first);
      const input = record(second);
      const path = string(input.path, 4096);
      const absolute = resolve(repo, path);
      const resolved = await realpath(absolute).catch(() => absolute);
      const group = string(input.group, 32);
      if (!inside(repo, absolute) || !inside(repo, resolved) ||
          !['staged', 'unstaged', 'untracked', 'conflicted', 'working'].includes(group)) throw new Error('Git file diff denied');
      return invoke(channel, [repo, { path: relative(repo, absolute), group }]);
    }
    default:
      throw new Error('Extension command is unavailable in the browser');
  }
}
