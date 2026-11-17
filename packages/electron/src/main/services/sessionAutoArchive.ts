import { app, BrowserWindow } from 'electron';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { ProviderFactory } from '@nimbalyst/runtime/ai/server/ProviderFactory';
import { readSessionPolicy } from '@nimbalyst/runtime/ai/sessionPolicy';
import { parseJsonObjectColumn } from '../utils/jsonColumn';
import { safeOn } from '../utils/ipcRegistry';
import { getDatabase } from '../database/initialize';
import { runWhenFirstUsable } from './startupMaintenanceGate';
import { SESSION_DESCENDANTS_CTE } from './sessionHierarchy';
import { destroyProviderForArchivedSession } from './ai/archiveSessionProviderLifecycle';
import { getProjectWindows } from '../window/windowState';

let installed = false;
let busy = false;
let stopping = false;
const visible = new Map<number, string | null>();

export function configureSessionAutoArchive(): void {
  if (installed) return;
  installed = true;
  safeOn('sessions:visible-session', (event, id: unknown) => {
    if (typeof id === 'string' || id === null) visible.set(event.sender.id, id);
  });
  getSessionStateManager().on('session:completed', (event: { sessionId: string }) => {
    void markCompleted(event.sessionId).catch(error => console.warn('[SessionAutoArchive] Could not record completion', error));
  });
  runWhenFirstUsable('session-auto-archive', () => {
    if (stopping) return;
    const timer = setInterval(() => { void sweepSessionAutoArchive(); }, 60_000);
    timer.unref?.();
    app.once('before-quit', () => { stopping = true; clearInterval(timer); });
    return sweepSessionAutoArchive();
  });
}

async function markCompleted(id: string): Promise<void> {
  const session = await AISessionsRepository.get(id);
  if (!session || !readSessionPolicy(session.metadata).autoArchiveAfterMinutes) return;
  await AISessionsRepository.updateMetadata(id, { metadata: { autoArchiveCompletedAt: Date.now() } });
}

/** Pure eligibility check; the store repeats durable safety checks atomically. */
export function autoArchiveDue(metadata: unknown, now: number): { minutes: number; completedAt: number; cutoff: string } | null {
  const policy = readSessionPolicy(metadata);
  const completedAt = Number(parseJsonObjectColumn(metadata).autoArchiveCompletedAt);
  if (!policy.autoArchiveAfterMinutes || !Number.isFinite(completedAt) || completedAt <= 0 || now - completedAt < policy.autoArchiveAfterMinutes * 60_000) return null;
  return { minutes: policy.autoArchiveAfterMinutes, completedAt, cutoff: new Date(now - policy.autoArchiveAfterMinutes * 60_000).toISOString() };
}

export async function sweepSessionAutoArchive(): Promise<void> {
  if (busy || stopping) return;
  busy = true;
  try {
    const db = getDatabase();
    const { rows } = await db.query<{ id: string; metadata: unknown }>(`SELECT id,
      jsonb_build_object('generateSummary',metadata->'generateSummary','autoArchiveAfterMinutes',metadata->'autoArchiveAfterMinutes',
        'autoArchiveCompletedAt',metadata->'autoArchiveCompletedAt') AS metadata
      FROM ai_sessions WHERE is_archived=FALSE AND status='idle'
        AND CAST(metadata->>'autoArchiveAfterMinutes' AS BIGINT)>0
        AND CAST(metadata->>'autoArchiveCompletedAt' AS BIGINT)>0
      ORDER BY last_activity ASC LIMIT 100`);
    for (const row of rows) {
      const guard = autoArchiveDue(row.metadata, Date.now());
      if (!guard) continue;
      const { rows: members } = await db.query<{ id: string }>(`${SESSION_DESCENDANTS_CTE} SELECT id FROM session_subtree`, [row.id]);
      const ids = new Set(members.map(member => member.id));
      // Only project windows host session selections. Capture/settings windows
      // never report one and must not block every idle session indefinitely.
      // Keep unreported project windows protected, including hidden ones.
      if (getProjectWindows().some(window => !visible.has(window.webContents.id) || ids.has(visible.get(window.webContents.id) ?? ''))) continue;
      if (members.some(member => { const state = getSessionStateManager().getSessionState(member.id); return state && (state.status !== 'idle' || state.isStreaming); })) continue;
      try {
        for (const window of BrowserWindow.getAllWindows()) if (!window.isDestroyed()) window.webContents.send('sessions:auto-archiving', { sessionIds: [...ids] });
        await AISessionsRepository.updateMetadata(row.id, { isArchived: true, autoArchiveGuard: guard, metadata: { autoArchivedAt: Date.now() } });
        for (const id of ids) destroyProviderForArchivedSession(id, key => ProviderFactory.destroyProvider(key), (_key, error) => console.warn('[SessionAutoArchive] Provider cleanup failed', error));
        console.info(`[SessionAutoArchive] Archived ${row.id}; transcript and worktree retained.`);
      } catch (error) { console.info(`[SessionAutoArchive] Deferred ${row.id}: ${error instanceof Error ? error.message : 'state changed'}`); }
    }
  } catch (error) { console.warn('[SessionAutoArchive] Sweep failed', error); }
  finally { busy = false; }
}
