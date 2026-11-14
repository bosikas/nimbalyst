import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const state = vi.hoisted(() => ({ root: '', rows: [] as any[], queued: [] as any[], interactive: [] as any[], workspace: '/project' }));
vi.mock('electron', () => ({ app: { getPath: () => state.root } }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: async () => ({ id: 'source', workspacePath: state.workspace, messages: ['OLD_TRANSCRIPT_MUST_NOT_BE_REPLAYED'], metadata: { nestedHistory: 'OLD_NESTED_REPORT' } }) } }));
vi.mock('../../utils/workspaceIdentity', () => ({ sameWorkspaceIdentity: (a: string, b: string) => a === b }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ query: async (sql: string) => ({ rows: sql.includes('queued_prompts') ? state.queued : sql.includes("message_kind = 'user'") ? state.rows : state.interactive }) }) }));
import { prepareSessionHandoff, prepareReviewedHandoff } from '../sessionHandoffService';

const spillDirectories: string[] = [];
beforeEach(async () => {
  state.root = await mkdtemp(join(tmpdir(), 'handoff-service-test-'));
  state.rows = [{ id: 1, searchable_text: 'Keep my human instruction', metadata: JSON.stringify({ promptProvenance: { actor: 'human' } }) }];
  state.queued = []; state.interactive = []; state.workspace = '/project';
});
afterEach(async () => {
  await rm(state.root, { recursive: true, force: true });
  await Promise.all(spillDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});
function brief(digest: string) {
  return { sourceDigest: digest, decisions: ['Use existing runtime'], ownership: ['Successor owns delivery'], pendingInstructions: ['No restart'], validationEvidence: ['/tmp/check.log'], requests: [{ id: '1', status: 'pending', reason: 'Still applies' }] };
}
describe('handoff preparation and evidence', () => {
  it('spills long review manifests without losing any request id or full text', async () => {
    state.rows = Array.from({ length: 200 }, (_, id) => ({ id, searchable_text: `Human request ${id} ` + 'detail '.repeat(80), metadata: null }));
    const output = await prepareSessionHandoff('source', '/project');
    expect(Buffer.byteLength(output, 'utf8')).toBeLessThanOrEqual(24_000);
    expect(output.split('\n').length).toBeLessThanOrEqual(100);
    const fullFile = output.match(/Full output saved to: ([^\n]+)/)![1];
    spillDirectories.push(dirname(fullFile));
    const manifest = JSON.parse(await readFile(fullFile, 'utf8'));
    expect(manifest.requestsToReview).toHaveLength(200);
    const ledger = JSON.parse(await readFile(manifest.evidencePath, 'utf8'));
    expect(ledger.snapshot.requests[199].text).toBe(state.rows[199].searchable_text);
  });
  it('writes a private durable full ledger and validates source workspace', async () => {
    const preview = JSON.parse(await prepareSessionHandoff('source', '/project'));
    const full = JSON.parse(await readFile(preview.evidencePath, 'utf8'));
    expect(full.snapshot.requests[0].text).toBe(state.rows[0].searchable_text);
    expect(JSON.stringify(full)).not.toContain('OLD_TRANSCRIPT_MUST_NOT_BE_REPLAYED');
    expect(JSON.stringify(full)).not.toContain('OLD_NESTED_REPORT');
    expect((await stat(preview.evidencePath)).mode & 0o777).toBe(0o600);
    await expect(prepareSessionHandoff('source', '/other')).rejects.toThrow(/workspace/);
  });
  it('rejects a new human request arriving after review, without writing a new packet', async () => {
    const preview = JSON.parse(await prepareSessionHandoff('source', '/project'));
    state.rows.push({ id: 2, searchable_text: 'New constraint', metadata: null });
    await expect(prepareReviewedHandoff('source', '/project', brief(preview.sourceDigest), 'Continue')).rejects.toThrow(/changed/);
    expect(await readdir(join(state.root, 'session-handoffs'))).toHaveLength(1);
  });
  it('keeps unresolved source approvals at source and never reinterprets them as authorization', async () => {
    state.interactive = [{ content: JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: { questions: [{ question: 'Approve this?' }] } }] } }) }];
    const preview = JSON.parse(await prepareSessionHandoff('source', '/project'));
    expect(preview.pendingQuestions).toEqual(['Question: Approve this?']);
    await expect(prepareReviewedHandoff('source', '/project', brief(preview.sourceDigest), 'Continue')).rejects.toThrow(/Resolve pending/);
  });
  it('bounds large pending instructions by both ceilings and retains complete evidence', async () => {
    state.rows[0].searchable_text = '界\n'.repeat(20_000) + 'FINAL_HUMAN_CONSTRAINT';
    const preview = JSON.parse(await prepareSessionHandoff('source', '/project'));
    const { prompt, state: retained } = await prepareReviewedHandoff('source', '/project', brief(preview.sourceDigest), 'Continue');
    const durable = JSON.parse(await readFile(retained.evidencePath, 'utf8'));
    expect(durable.handoffId).toBe(retained.id);
    expect(Buffer.byteLength(prompt, 'utf8')).toBeLessThanOrEqual(24_000);
    expect(prompt.split('\n').length).toBeLessThanOrEqual(100);
    const fullFile = prompt.match(/Full output saved to: ([^\n]+)/)![1];
    spillDirectories.push(dirname(fullFile));
    expect(await readFile(fullFile, 'utf8')).toContain(state.rows[0].searchable_text);
    expect(prompt).toContain('Read the full file');
  });
});
