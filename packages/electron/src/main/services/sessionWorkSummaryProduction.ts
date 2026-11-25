import { app } from 'electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { readSessionNarrative, readSessionWorkSummary, type SessionWorkSummary } from '@nimbalyst/runtime/ai/sessionWorkSummary';
import { getSessionStateManager } from '@nimbalyst/runtime/ai/server/SessionStateManager';
import { ModelRegistry } from '@nimbalyst/runtime/ai/server/ModelRegistry';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import { getDatabase } from '../database/initialize';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import { SessionNamingService } from './SessionNamingService';
import { buildHandoffSnapshot } from './sessionHandoff';
import { completeWorkSummaryWithCodex, cancelWorkSummaryCompletions, type WorkSummaryTokenUsage } from './codexWorkSummaryCompletion';
import { acceptWorkSummary, buildWorkSummaryInput, type WorkSummaryRecord, type WorkSummarySource } from './sessionWorkSummary';
import { SessionWorkSummaryQueue } from './sessionWorkSummaryQueue';
import { runWhenFirstUsable } from './startupMaintenanceGate';
import { readSessionPolicy } from '@nimbalyst/runtime/ai/sessionPolicy';
import { setUpdateSessionSummaryFn } from '../mcp/sessionNamingServer';
import { readSessionSummaryDraft, readSummaryWork, SessionSummaryDelivery } from './sessionSummaryDelivery';
import { sendSummaryWork } from './sessionSummaryWork';

let isEnabled = (_workspace: string) => false;
let installed = false;
let quitting = false;
const retries = new Map<string, number>();
const delivery = new SessionSummaryDelivery();
const automatic = new Set<string>();
const queue = new SessionWorkSummaryQueue(update, error => console.warn('[SessionWorkSummary] Background update failed:', error instanceof Error ? error.message : 'unknown error'));

/** All providers share this host lifecycle; no working-agent compliance required. */
export function configureSessionWorkSummaries(enabled: (workspace: string) => boolean): void {
  isEnabled = enabled;
  if (installed) return;
  installed = true;
  setUpdateSessionSummaryFn(submitSessionWorkSummary);
  app.once?.('before-quit', () => { quitting = true; queue.stop(); cancelWorkSummaryCompletions(); });
  getSessionStateManager().on('session:started', (event: { sessionId: string }) => {
    const state = getSessionStateManager().getSessionState(event.sessionId);
    if (state) delivery.started(event.sessionId, state);
  });
  getSessionStateManager().on('session:completed', (event: { sessionId: string; workspacePath?: string }) => {
    if (event.workspacePath && !delivery.submitted(event.sessionId)) {
      automatic.add(event.sessionId);
      requestSessionWorkSummary(event.sessionId, event.workspacePath, true);
    }
  });
}

export function requestSessionWorkSummary(sessionId: string, workspacePath: string, fallback = false): void {
  if (quitting) return;
  if (!fallback) automatic.delete(sessionId);
  if (!sessionId || !workspacePath) throw new Error('A session and workspace are required.');
  retries.delete(sessionId);
  runWhenFirstUsable('session-work-summary', () => {
    if (!quitting) queue.request(sessionId, workspacePath);
  });
}

/** The authenticated MCP session supplies ownership; callers cannot target peers. */
export async function submitSessionWorkSummary(sessionId: string, value: unknown): Promise<string> {
  const draft = readSessionSummaryDraft(value);
  const revision = delivery.revision(sessionId);
  if (!revision) throw new Error('No active session turn.');
  return delivery.write(sessionId, async () => {
    if (delivery.revision(sessionId) !== revision) throw new Error('The session moved to another turn.');
    const session = await AISessionsRepository.get(sessionId);
    if (!session || session.metadata?.remoteHostDeviceId) throw new Error('Local session not available.');
    if (!readSessionPolicy(session.metadata).generateSummary || session.isArchived) return 'Summary generation is disabled for this session.';
    const old = readSessionWorkSummary(object(session.metadata).workSummary);
    const directory = join(app.getPath('userData'), 'session-work-summaries', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let workerEvidencePath = old?.evidencePath;
    if (workerEvidencePath) {
      const path = resolve(workerEvidencePath);
      if (!path.startsWith(resolve(directory) + sep)) throw new Error('Summary evidence is outside its session directory.');
      const checkpoint = JSON.parse(await readFile(path, 'utf8'));
      if (checkpoint.kind === 'agent') workerEvidencePath = checkpoint.workerEvidencePath;
    }
    const { rows } = await getDatabase().query<{ id: number }>('SELECT id FROM ai_agent_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 1', [sessionId]);
    const evidencePath = join(directory, `agent-${randomUUID()}.json`);
    const throughMessageId = rows[0]?.id ?? 0;
    const narrative = readSessionNarrative({ ...readSessionNarrative(old), ...readSessionNarrative(draft) });
    const writeUp = narrative.writeUp?.map(({ messageId, ...point }) => messageId && messageId <= throughMessageId ? { ...point, messageId } : point);
    const summary: SessionWorkSummary = { ...draft, ...narrative, ...(writeUp ? { writeUp } : {}),
      source: 'agent', state: 'ready', coverage: 'partial', updatedAt: Date.now(), throughMessageId, evidencePath };
    // Keep the worker's request ledger reachable. A future fallback resumes its
    // cursor, never skips human requests based on an agent's self-report.
    await writeFile(evidencePath, JSON.stringify({ kind: 'agent', summary, previousEvidencePath: old?.evidencePath, workerEvidencePath }), { flag: 'wx', mode: 0o600 });
    if (delivery.revision(sessionId) !== revision) throw new Error('The session moved to another turn.');
    await SessionNamingService.getInstance().applySessionMetadata(sessionId, { workSummary: summary });
    delivery.accept(sessionId, revision);
    let work: unknown[] | undefined;
    try { work = readSummaryWork(value); }
    catch { return 'Session summary updated. Invalid Work Overview changes were skipped.'; }
    if (!work?.length || !session.workspacePath) return 'Session summary updated; no separate inference was needed.';
    return `Session summary updated.${await sendSummaryWork(session.workspacePath, {
      sessionId, updatedAt: summary.updatedAt, throughMessageId: summary.throughMessageId, remaining: summary.remaining, updates: work,
    })}`;
  });
}

interface Row { id: number; message_kind: string; searchable_text: string | null; metadata: unknown; content: string; text_length: number }
function object(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') { try { return object(JSON.parse(value)); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

async function update(sessionId: string, workspacePath: string): Promise<boolean> {
  const fallback = automatic.delete(sessionId);
  if (fallback && delivery.submitted(sessionId)) return false;
  if (fallback) {
    const state = getSessionStateManager().getSessionState(sessionId);
    if (state && state.status !== 'idle' && state.status !== 'error') return false;
  }
  const revision = delivery.revision(sessionId);
  const session = await AISessionsRepository.get(sessionId);
  if (!session || !sameWorkspaceIdentity(session.workspacePath ?? '', workspacePath) || session.metadata?.remoteHostDeviceId) return false;
  if (!readSessionPolicy(session.metadata).generateSummary || session.isArchived) return false;
  const old = readSessionWorkSummary(object(session.metadata).workSummary);
  const persist = (summary: SessionWorkSummary) => delivery.write(sessionId, async () => {
    if (delivery.revision(sessionId) !== revision) return;
    await SessionNamingService.getInstance().applySessionMetadata(sessionId, { workSummary: summary });
  });
  let previous: WorkSummaryRecord | undefined;
  try {
    const directory = join(app.getPath('userData'), 'session-work-summaries', sessionId.replace(/[^a-zA-Z0-9_-]/g, '_'));
    let checkpointPath = old?.evidencePath;
    const visited = new Set<string>();
    while (checkpointPath) {
      const recordPath = resolve(checkpointPath);
      if (!recordPath.startsWith(resolve(directory) + sep)) throw new Error('Summary evidence is outside its session directory.');
      if (visited.has(recordPath)) throw new Error('Summary evidence has a circular reference.');
      visited.add(recordPath);
      const record = JSON.parse(await readFile(recordPath, 'utf8'));
      if (record.kind === 'agent') { checkpointPath = record.workerEvidencePath; continue; }
      previous = record as WorkSummaryRecord;
      if (!readSessionWorkSummary(previous.summary) || !Array.isArray(previous.requests)) throw new Error('Summary checkpoint needs review.');
      break;
    }
    const db = getDatabase();
    const cursor = previous?.summary.throughMessageId ?? 0;
    const projection = `id, message_kind, SUBSTR(searchable_text, 1, 1600) AS searchable_text,
      LENGTH(COALESCE(searchable_text, content)) AS text_length, SUBSTR(content, 1, 1600) AS content,
      jsonb_build_object('promptProvenance', metadata->'promptProvenance', 'coalescedPromptProvenance', metadata->'coalescedPromptProvenance') AS metadata`;
    const { rows: inputRows } = await db.query<Row>(`SELECT ${projection} FROM ai_agent_messages
      WHERE session_id=$1 AND message_kind='user' AND id>$2 AND (hidden=FALSE OR hidden IS NULL) ORDER BY id ASC LIMIT 9`, [sessionId, cursor]);
    let requests = inputRows.slice(0, 8);
    let historyCoverage: WorkSummarySource['historyCoverage'];
    if (inputRows.length > 8) {
      // One inference per trigger, rather than replaying an old session in many
      // paid pages. Include the opening goals and latest requests, and mark the
      // intervening evidence explicitly partial. Canonical records stay intact.
      const { rows: newest } = await db.query<Row>(`SELECT ${projection} FROM ai_agent_messages
        WHERE session_id=$1 AND message_kind='user' AND id>$2 AND (hidden=FALSE OR hidden IS NULL) ORDER BY id DESC LIMIT 4`, [sessionId, cursor]);
      const opening = inputRows.slice(0, 4);
      const end = newest.reverse();
      requests = [...new Map([...opening, ...end].map(row => [row.id, row])).values()].sort((a, b) => a.id - b.id);
      historyCoverage = { mode: 'bounded-first-and-latest', canonicalSessionId: sessionId, afterMessageId: opening.at(-1)!.id, beforeMessageId: end[0]?.id ?? inputRows.at(-1)!.id };
    }
    const { rows: latest } = await db.query<{ id: number }>(`SELECT id FROM ai_agent_messages WHERE session_id=$1 ORDER BY id DESC LIMIT 1`, [sessionId]);
    const throughMessageId = latest[0]?.id ?? cursor;
    if (throughMessageId <= cursor) return false;
    const { rows: outputRows } = await db.query<Row>(`SELECT ${projection} FROM ai_agent_messages
      WHERE session_id=$1 AND message_kind='assistant' AND id>$2 AND id<=$3 AND (hidden=FALSE OR hidden IS NULL)
      ORDER BY id DESC LIMIT 4`, [sessionId, cursor, throughMessageId]);
    if (!requests.length && !outputRows.length) return false;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const evidencePath = join(directory, `record-${throughMessageId}-${randomUUID()}.json`);
    const source: WorkSummarySource = {
      title: session.title ?? '', throughMessageId, historyCoverage,
      requests: buildHandoffSnapshot(sessionId, requests, []).requests,
      recent: [...requests, ...outputRows.reverse()].sort((a, b) => a.id - b.id).map(row => ({ id: String(row.id), role: row.message_kind, text: row.searchable_text ?? row.content })),
      // Coverage accounts for human instructions. Recent assistant evidence is
      // deliberately bounded; its truncation cannot itself erase a request.
      partial: !!historyCoverage || requests.some(row => row.text_length > 1600), evidencePath,
    };
    if (!isEnabled(workspacePath)) throw new Error('Automatic summaries need Codex enabled and signed in for this workspace.');
    const fallback: SessionWorkSummary = old ?? { scope: '', remaining: 'Remaining work has not been assessed.', attention: 'unknown', areas: [], updatedAt: 0, throughMessageId: 0, state: 'updating', coverage: 'partial' };
    await persist({ ...fallback, state: 'updating', error: undefined });
    const modelId = session.provider === 'openai-codex' ? session.model : await ModelRegistry.getDefaultModel('openai-codex');
    const model = modelId ? ModelIdentifier.tryParse(modelId)?.model ?? modelId : undefined;
    const input = buildWorkSummaryInput(source, previous);
    if (delivery.revision(sessionId) !== revision) return false;
    let usage: WorkSummaryTokenUsage | undefined;
    let raw = '';
    let record: WorkSummaryRecord;
    let accepted = false;
    const startedAt = Date.now();
    try {
      raw = await completeWorkSummaryWithCodex(input, model, measured => { usage = measured; });
      record = acceptWorkSummary(raw, source, previous, Date.now());
      record.summary = { ...readSessionNarrative(old), ...record.summary, source: 'background' };
      if (usage) record.summary.tokenUsage = usage;
      accepted = true;
    } finally {
      // Every attempted inference gets a durable meter, including rejected JSON
      // and retries. Unknown native usage is explicit, never recorded as zero.
      await writeFile(join(directory, `attempt-${startedAt}-${randomUUID()}.json`), JSON.stringify({
        startedAt, finishedAt: Date.now(), model, accepted, inputBytes: Buffer.byteLength(input), outputBytes: Buffer.byteLength(raw),
        tokenUsage: usage ?? null, usageSource: usage ? 'codex-native-turn.completed' : 'unavailable',
      }), { flag: 'wx', mode: 0o600 });
    }
    // Immutable checkpoints retain evidence and historical summaries; no transcript rewrites.
    await writeFile(evidencePath, JSON.stringify({ ...record!, tokenUsage: usage ?? null, previousEvidencePath: old?.evidencePath, source, inputBytes: Buffer.byteLength(input), outputBytes: Buffer.byteLength(raw) }), { flag: 'wx', mode: 0o600 });
    await persist(record!.summary);
    retries.delete(sessionId);
    return false;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Summary update failed.';
    const summary: SessionWorkSummary = old ?? { scope: '', remaining: 'Remaining work has not been assessed.', attention: 'unknown', areas: [], updatedAt: 0, throughMessageId: 0, state: 'unavailable', coverage: 'partial' };
    if (quitting) return false;
    await persist({ ...summary, state: old?.scope ? 'stale' : 'unavailable', error: message.slice(0, 240) });
    console.warn(`[SessionWorkSummary] ${sessionId}: ${message}`);
    if (isEnabled(workspacePath) && (retries.get(sessionId) ?? 0) < 1) {
      retries.set(sessionId, 1);
      setTimeout(() => {
        if (delivery.revision(sessionId) === revision) queue.request(sessionId, workspacePath);
      }, 5000);
    }
    return false;
  }
}
