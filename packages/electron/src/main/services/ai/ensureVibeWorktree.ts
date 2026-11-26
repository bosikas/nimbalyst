import { createHash } from 'node:crypto';
import { stat } from 'node:fs/promises';
import type { WebContents } from 'electron';
import { ProviderFactory } from '@nimbalyst/runtime/ai/server/ProviderFactory';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import type { WorktreeCreateResult } from '../../../shared/ipc/types';
import { invokeBrowserPanelCommand } from '../../browserHost/browserPanelCommands';
import { database } from '../../database/PGLiteDatabaseWorker';
import { createWorktreeStore } from '../WorktreeStore';
import { simpleGitReadOnly } from '../gitReadOnly';
import { resolveDefaultRepo } from '../workspaceRepos';

type SessionWorktree = { id: string; path: string; projectPath: string };

const pending = new Map<string, Promise<SessionWorktree | undefined>>();

async function requireCheckout(path: string | undefined): Promise<string> {
  if (!path || !(await stat(path).catch(() => undefined))?.isDirectory()) {
    throw new Error('The worktree assigned to this Mistral Vibe session is unavailable.');
  }
  return path;
}

async function prepareCheckout(sessionId: string, workspacePath: string, sender: WebContents) {
  const session = await AISessionsRepository.get(sessionId);
  if (!session) throw new Error('Mistral Vibe session not found.');
  const projectPath = session.worktreeProjectPath ?? session.workspacePath ?? workspacePath;
  if (session.worktreeId) {
    return { id: session.worktreeId, path: await requireCheckout(session.worktreePath), projectPath };
  }
  const sourceRepo = resolveDefaultRepo(projectPath) ?? projectPath;
  if (!await simpleGitReadOnly(sourceRepo).checkIsRepo()) return;

  // Reuse a checkout if creation succeeded but attaching it to the session failed.
  const name = 'vibe-' + createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
  const store = createWorktreeStore(database);
  let worktree = (await store.list(projectPath)).find((entry) => entry.name === name);
  if (!worktree) {
    const result = await invokeBrowserPanelCommand('worktree:create', sender, [
      projectPath, { name, sourceFolderPath: sourceRepo },
    ]) as WorktreeCreateResult;
    if (!result.success || !result.worktree) {
      throw new Error(result.error ?? 'Could not create a worktree for Mistral Vibe.');
    }
    worktree = result.worktree;
  }
  await requireCheckout(worktree.path);

  const latest = await AISessionsRepository.get(sessionId);
  if (latest?.worktreeId) {
    return { id: latest.worktreeId, path: await requireCheckout(latest.worktreePath), projectPath: latest.worktreeProjectPath ?? projectPath };
  }
  const result = await invokeBrowserPanelCommand('sessions:update-metadata', sender, [
    sessionId, { worktreeId: worktree.id },
  ]) as { success: boolean; error?: string };
  if (!result.success) throw new Error(result.error ?? 'Could not attach the worktree to the Mistral Vibe session.');

  // ACP retains the original cwd for a loaded session. Relaunch and load its
  // persisted provider session ID into the new checkout on the next call.
  ProviderFactory.destroyProvider(sessionId, 'mistral-vibe');
  return worktree;
}

export function ensureVibeWorktree(sessionId: string, workspacePath: string, sender: WebContents) {
  const existing = pending.get(sessionId);
  if (existing) return existing;
  const preparation = prepareCheckout(sessionId, workspacePath, sender).finally(() => pending.delete(sessionId));
  pending.set(sessionId, preparation);
  return preparation;
}
