// @vitest-environment node
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { setTimeout as waitForFiles } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ directory: '', metadata: {} as Record<string, any>, query: vi.fn(), complete: vi.fn(), state: null as unknown as EventEmitter, getSessionState: vi.fn(), title: 'Navigation', id: 'work-summary-hook' }));
vi.mock('electron', () => ({ app: { getPath: () => fake.directory } }));
vi.mock('../startupMaintenanceGate', () => ({ runWhenFirstUsable: (_label: string, run: () => void) => run() }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => ({ id: fake.id, title: fake.title, provider: 'openai-codex', model: 'openai-codex:gpt-6.1-sol', workspacePath: '/project', metadata: fake.metadata }) } }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => Object.assign(fake.state, { getSessionState: fake.getSessionState }) }));
vi.mock('../../mcp/sessionNamingServer', () => ({ setUpdateSessionSummaryFn: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server/ModelRegistry', () => ({ ModelRegistry: { getDefaultModel: async () => 'openai-codex:gpt-6.1-sol' } }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ query: fake.query }) }));
vi.mock('../../utils/workspaceIdentity', () => ({ sameWorkspaceIdentity: (a: string, b: string) => a === b }));
vi.mock('../SessionNamingService', () => ({ SessionNamingService: { getInstance: () => ({ applySessionMetadata: async (_id: string, patch: object) => { fake.metadata = { ...fake.metadata, ...patch }; } }) } }));
vi.mock('../codexWorkSummaryCompletion', () => ({ completeWorkSummaryWithCodex: fake.complete }));
vi.mock('../sessionSummaryWork', () => ({ sendSummaryWork: vi.fn() }));
import { configureSessionWorkSummaries, requestSessionWorkSummary, submitSessionWorkSummary } from '../sessionWorkSummaryProduction';

beforeEach(async () => {
  vi.useFakeTimers();
  fake.directory = await mkdtemp(join(tmpdir(), 'work-summary-test-'));
  fake.metadata = {};
  fake.complete.mockReset(); fake.query.mockReset();
  fake.getSessionState.mockReturnValue({ status: 'running' });
  fake.state ??= new EventEmitter();
  configureSessionWorkSummaries(() => true);
  fake.state.emit('session:started', { sessionId: fake.id });
  fake.getSessionState.mockReturnValue(null);
  fake.query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.includes("message_kind='user'")) return { rows: Number(args[1]) < 10 ? [{ id: 10, message_kind: 'user', searchable_text: 'Improve navigation; installation remains pending.', metadata: { promptProvenance: { actor: 'human' } }, content: '', text_length: 49 }] : [] };
    if (sql.includes("message_kind='assistant'")) return { rows: [{ id: 12, message_kind: 'assistant', searchable_text: 'Navigation implemented; installation pending.', metadata: {}, content: '', text_length: 44 }] };
    return { rows: [{ id: 12 }] };
  });
  fake.complete.mockResolvedValue(JSON.stringify({ scope: 'Session navigation and local build customization', remaining: 'Install and review the local app.', attention: 'review', areas: ['Navigation'], requests: [{ id: '10', status: 'pending', evidence: '12: Installation remains pending.' }] }));
});
afterEach(async () => { vi.useRealTimers(); await rm(fake.directory, { recursive: true, force: true }); });

async function settle(check: () => void) {
  // Fake timers drive debounce/retry; real filesystem promises still need an IO turn.
  for (let attempt = 0; attempt < 100; attempt++) {
    await vi.runAllTimersAsync();
    await waitForFiles(2);
    try { check(); return; } catch { /* Keep waiting for the immutable checkpoint write. */ }
  }
  check();
}

it('uses the host completion hook, deduplicates delivery, and stores an immutable source checkpoint', async () => {
  fake.state.emit('session:completed', { sessionId: fake.id, workspacePath: '/project' });
  fake.state.emit('session:completed', { sessionId: fake.id, workspacePath: '/project' });
  await settle(() => expect(fake.metadata.workSummary?.state).toBe('ready'));
  expect(fake.complete).toHaveBeenCalledOnce();
  expect(fake.metadata.workSummary).toMatchObject({ scope: 'Session navigation and local build customization', attention: 'review', state: 'ready', throughMessageId: 12 });
  const checkpoint = JSON.parse(await readFile(fake.metadata.workSummary.evidencePath, 'utf8'));
  expect(checkpoint.requests).toEqual([expect.objectContaining({ id: '10', status: 'pending' })]);
  expect(checkpoint.source.requests[0].text).toContain('installation remains pending');
  expect(checkpoint.inputBytes).toBeLessThan(20000);
  requestSessionWorkSummary(fake.id, '/project'); await settle(() => expect(fake.metadata.workSummary?.state).toBe('ready'));
  expect(fake.complete).toHaveBeenCalledOnce();
});

it('keeps the previous caption and checkpoint stale on inference failure, retries once, then allows manual retry', async () => {
  requestSessionWorkSummary(fake.id, '/project'); await settle(() => expect(fake.metadata.workSummary?.state).toBe('ready'));
  const previousPath = fake.metadata.workSummary.evidencePath;
  fake.query.mockImplementation(async (sql: string) => sql.includes("message_kind='user'") ? { rows: [] } : { rows: [{ id: 20, message_kind: 'assistant', searchable_text: 'Adjusted spacing.', metadata: {}, content: '', text_length: 17 }] });
  fake.complete.mockRejectedValue(new Error('offline'));
  requestSessionWorkSummary(fake.id, '/project'); await settle(() => { expect(fake.complete).toHaveBeenCalledTimes(3); expect(fake.metadata.workSummary?.state).toBe('stale'); });
  expect(fake.complete).toHaveBeenCalledTimes(3);
  expect(fake.metadata.workSummary).toMatchObject({ state: 'stale', throughMessageId: 12, evidencePath: previousPath });
  expect(JSON.parse(await readFile(previousPath, 'utf8')).requests[0].status).toBe('pending');
  const attempts = await Promise.all((await readdir(dirname(previousPath))).filter(name => name.startsWith('attempt-')).map(async name => JSON.parse(await readFile(join(dirname(previousPath), name), 'utf8'))));
  expect(attempts.filter(attempt => attempt.accepted === false)).toHaveLength(2);
  expect(attempts.filter(attempt => attempt.accepted === false).every(attempt => attempt.tokenUsage === null && attempt.usageSource === 'unavailable')).toBe(true);
  fake.complete.mockResolvedValue(JSON.stringify({ scope: 'Session navigation and local build customization', remaining: 'Install the app.', attention: 'next', areas: ['Navigation'], requests: [{ id: '10', status: 'pending', evidence: '20: Spacing changed; installation remains unverified.' }] }));
  requestSessionWorkSummary(fake.id, '/project'); await settle(() => expect(fake.metadata.workSummary?.throughMessageId).toBe(20));
  expect(fake.metadata.workSummary).toMatchObject({ state: 'ready', throughMessageId: 20 });
});

it('does not run inference for another workspace', async () => {
  requestSessionWorkSummary(fake.id, '/other-project'); await vi.runAllTimersAsync();
  expect(fake.complete).not.toHaveBeenCalled();
});

it('uses one explicitly partial first/latest snapshot for long histories and records native usage', async () => {
  const user = (id: number) => ({ id, message_kind: 'user', searchable_text: `Human request ${id}`, metadata: { promptProvenance: { actor: 'human' } }, content: '', text_length: 20 });
  fake.query.mockImplementation(async (sql: string) => sql.includes("message_kind='user'")
    ? { rows: sql.includes('DESC LIMIT 4') ? [100, 99, 98, 97].map(user) : [1, 2, 3, 4, 5, 6, 7, 8, 9].map(user) }
    : sql.includes("message_kind='assistant'") ? { rows: [{ ...user(101), message_kind: 'assistant' }] } : { rows: [{ id: 101 }] });
  fake.complete.mockImplementation(async (input: string, _model: string, measured: Function) => {
    measured({ inputTokens: 1200, cachedInputTokens: 300, outputTokens: 200 });
    const data = JSON.parse(input);
    return JSON.stringify({ scope: 'Improve session navigation across the project', remaining: 'Review recent navigation changes.', attention: 'review', areas: ['Navigation'], requests: data.requests.map((r: { id: string }) => ({ id: r.id, status: 'pending', evidence: '101: Needs review.' })) });
  });
  requestSessionWorkSummary(fake.id, '/project');
  await settle(() => expect(fake.metadata.workSummary?.throughMessageId).toBe(101));
  expect(fake.complete).toHaveBeenCalledOnce();
  expect(fake.metadata.workSummary).toMatchObject({ coverage: 'partial', attention: 'unknown' });
  const record = JSON.parse(await readFile(fake.metadata.workSummary.evidencePath, 'utf8'));
  expect(record.source.historyCoverage).toMatchObject({ mode: 'bounded-first-and-latest', afterMessageId: 4, beforeMessageId: 97 });
  expect(record.requests.map((r: { id: string }) => r.id)).toEqual(['1','2','3','4','97','98','99','100']);
  expect(record.tokenUsage).toEqual({ inputTokens: 1200, cachedInputTokens: 300, outputTokens: 200 });
});

it('does not read transcripts or infer when summaries are disabled, including repeated hook and manual requests', async () => {
  fake.metadata = { generateSummary: false };
  fake.state.emit('session:completed', { sessionId: fake.id, workspacePath: '/project' });
  requestSessionWorkSummary(fake.id, '/project');
  await vi.runAllTimersAsync();
  expect(fake.query).not.toHaveBeenCalled();
  expect(fake.complete).not.toHaveBeenCalled();
});

const agentDraft = { scope: 'Improve session navigation and local build customization', remaining: 'Install and review the app.', attention: 'review', areas: ['Navigation'] };

it('uses a valid same-turn agent summary without launching the background worker', async () => {
  const narrative = { outcome: 'Updated the session navigation.', writeUp: [
    { kind: 'decision', text: 'Keep the current session visible so navigation preserves context.', messageId: 12 },
  ] };
  await submitSessionWorkSummary(fake.id, { ...agentDraft, ...narrative });
  await submitSessionWorkSummary(fake.id, agentDraft);
  fake.state.emit('session:completed', { sessionId: fake.id, workspacePath: '/project' });
  await vi.runAllTimersAsync();
  expect(fake.complete).not.toHaveBeenCalled();
  expect(fake.metadata.workSummary).toMatchObject({ ...agentDraft, ...narrative, source: 'agent', state: 'ready' });
  expect(JSON.parse(await readFile(fake.metadata.workSummary.evidencePath, 'utf8')).kind).toBe('agent');
});

it('falls back after an invalid submission or a later turn omits the summary', async () => {
  await expect(submitSessionWorkSummary(fake.id, { ...agentDraft, attention: 'none' })).rejects.toThrow('Invalid summary');
  fake.state.emit('session:completed', { sessionId: fake.id, workspacePath: '/project' });
  await settle(() => expect(fake.metadata.workSummary?.source).toBe('background'));
  await submitSessionWorkSummary(fake.id, agentDraft);
  fake.getSessionState.mockReturnValue({ status: 'running' });
  fake.state.emit('session:started', { sessionId: fake.id });
  fake.getSessionState.mockReturnValue(null);
  // Add evidence for the next turn beyond the worker checkpoint.
  fake.query.mockImplementation(async (sql: string) => sql.includes("message_kind='user'") ? { rows: [] } : { rows: [{ id: 20, message_kind: 'assistant', searchable_text: 'Spacing adjusted; installation pending.', metadata: {}, content: '', text_length: 39 }] });
  fake.complete.mockResolvedValue(JSON.stringify({ ...agentDraft, requests: [{ id: '10', status: 'pending', evidence: '20: Installation remains pending.' }] }));
  fake.state.emit('session:completed', { sessionId: fake.id, workspacePath: '/project' });
  await settle(() => expect(fake.metadata.workSummary?.throughMessageId).toBe(20));
  expect(fake.complete).toHaveBeenCalledTimes(2);
  const checkpoint = JSON.parse(await readFile(fake.metadata.workSummary.evidencePath, 'utf8'));
  expect(checkpoint.requests[0]).toMatchObject({ id: '10', status: 'pending' });
});

it('keeps a newer agent summary when an older background inference finishes later', async () => {
  let finish!: (value: string) => void;
  fake.complete.mockImplementation(() => new Promise<string>(resolve => { finish = resolve; }));
  requestSessionWorkSummary(fake.id, '/project');
  await settle(() => expect(fake.complete).toHaveBeenCalledOnce());
  await submitSessionWorkSummary(fake.id, agentDraft);
  const agentPath = fake.metadata.workSummary.evidencePath;
  finish(JSON.stringify({ ...agentDraft, scope: 'Old background summary of navigation changes', requests: [{ id: '10', status: 'pending', evidence: '12: Pending.' }] }));
  await settle(() => expect(fake.metadata.workSummary.evidencePath).toBe(agentPath));
  await waitForFiles(30);
  expect(fake.metadata.workSummary).toMatchObject({ scope: agentDraft.scope, source: 'agent', evidencePath: agentPath });
});

it('rejects peer or inactive sessions and respects disabled summary policy', async () => {
  await expect(submitSessionWorkSummary('other-session', agentDraft)).rejects.toThrow('No active session turn');
  fake.metadata = { generateSummary: false };
  expect(await submitSessionWorkSummary(fake.id, agentDraft)).toContain('disabled');
  expect(fake.metadata.workSummary).toBeUndefined();
  expect(fake.complete).not.toHaveBeenCalled();
});
