// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ files: [] as any[], prompts: [] as any[], reply: 'Latest result', pending: [] as any[], query: vi.fn() }));
vi.mock('@nimbalyst/runtime/storage/repositories/SessionFilesRepository', () => ({
  SessionFilesRepository: { getFilesBySession: async () => state.files },
}));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: async () => ({ id: 's1', title: 'Context work', provider: 'codex', createdAt: 1, updatedAt: 2, metadata: { phase: 'implementing' } }) },
}));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ query: state.query }) }));
import { handleGetSessionEditedFiles } from '../sessionEditedFiles';
import { handleGetSessionSummary } from '../sessionSummary';
import { boundSessionOutput } from '../sessionOutput';
import { uniqueSessionFilePaths } from '../sessionFilePaths';

let root: string;
const outputs: string[] = [];
async function fullOutput(text: string): Promise<string> {
  const path = text.match(/Full output saved to: ([^\n]+)/)?.[1];
  expect(path, 'omitted data must be available in a file').toBeTruthy();
  outputs.push(path!);
  return readFile(path!, 'utf8');
}
function expectBounded(text: string) {
  expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(24_000);
  expect(text.split('\n').length).toBeLessThanOrEqual(100);
}
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'session-context-test-')));
  state.files = [];
  state.prompts = [{ searchable_text: 'Implement context limits', metadata: null }];
  state.reply = 'Latest result';
  state.pending = [];
  state.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM')) return { rows: [{ id: 1 }] };
    if (sql.includes("message_kind = 'assistant'")) return { rows: [{ searchable_text: state.reply }] };
    if (sql.includes("message_kind = 'user'")) return { rows: state.prompts };
    return { rows: state.pending };
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await Promise.all(outputs.splice(0).map(path => rm(join(path, '..'), { recursive: true, force: true })));
});

describe('session edited-file discovery', () => {
  it('deduplicates relative, absolute, dot and directory aliases without dropping deleted paths or leaf symlinks', async () => {
    await mkdir(join(root, 'real'));
    await symlink(join(root, 'real'), join(root, 'alias'), 'junction');
    await writeFile(join(root, 'real', 'a.ts'), 'test');
    await symlink(join(root, 'real', 'a.ts'), join(root, 'link.ts'));
    state.files = ['real/a.ts', join(root, 'real', 'a.ts'), 'real/../real/a.ts', 'alias/a.ts', 'alias/deleted.ts', 'real/deleted.ts', 'link.ts']
      .map(filePath => ({ filePath, workspaceId: root }));
    const result = await handleGetSessionEditedFiles('s1');
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toBe(`Files edited in this session (3):\n- ${join(root, 'real/a.ts')}\n- ${join(root, 'real/deleted.ts')}\n- ${join(root, 'link.ts')}`);
  });
  it('bounds long lists but preserves every unique path in the full file for commit discovery', async () => {
    state.files = Array.from({ length: 200 }, (_, i) => ({ workspaceId: root, filePath: `deleted-${i}.ts` }));
    const result = await handleGetSessionEditedFiles('s1');
    const text = result.content[0].text!;
    expectBounded(text);
    const full = await fullOutput(text);
    expect(full.match(/^- /gm)).toHaveLength(200);
    expect(full).toContain(join(root, 'deleted-199.ts'));
    expect(text).toContain('commit');
  });
  it('retains no-session and no-edits behavior', async () => {
    expect((await handleGetSessionEditedFiles(undefined)).isError).toBe(true);
    expect((await handleGetSessionEditedFiles('s1')).content[0].text).toContain('No files');
  });
});

describe('session summary output', () => {
  it('keeps useful current context without expanding old prompts and synthetic inbox history', async () => {
    state.prompts = [
      { searchable_text: 'Original task ' + 'old detail\n'.repeat(200), metadata: null },
      { searchable_text: '[System: inbox] NESTED_HISTORY '.repeat(2000), metadata: null },
      { searchable_text: 'GENERATED_BRIEF '.repeat(2000), metadata: JSON.stringify({ promptOrigin: 'session_brief' }) },
      { searchable_text: 'Latest user decision', metadata: null },
    ];
    const text = await handleGetSessionSummary('s1', 's1', root);
    expectBounded(text);
    expect(text).toContain('Latest user decision');
    expect(text).toContain('Latest result');
    expect(text).not.toContain('NESTED_HISTORY');
    expect(text).not.toContain('GENERATED_BRIEF');
    const full = await fullOutput(text);
    expect(full).toContain('NESTED_HISTORY');
    expect(full).toContain('GENERATED_BRIEF');
  });
  it('bounds Unicode bytes even when output has very few lines, retaining the entire assistant reply', async () => {
    state.reply = '界'.repeat(20_000) + 'FINAL_RESULT';
    const text = await handleGetSessionSummary('s1', 's1', root);
    expectBounded(text);
    expect(text).not.toContain('\uFFFD');
    expect(await fullOutput(text)).toContain(state.reply);
  });
  it('keeps pending questions and recent decisions visible while preserving older turns in the file', async () => {
    state.prompts = Array.from({ length: 100 }, (_, i) => ({ searchable_text: `Decision ${i}`, metadata: null }));
    state.pending = [{ content: JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'question-1', name: 'AskUserQuestion', input: { questions: [{ question: 'Approve the result?' }] } },
    ] } }) }];
    const text = await handleGetSessionSummary('s1', 's1', root);
    expectBounded(text);
    expect(text).toContain('Decision 0');
    expect(text).toContain('Decision 99');
    expect(text).not.toContain('Decision 50');
    expect(text).toMatch(/Question: Approve the result\?$/);
    expect(await fullOutput(text)).toContain('Decision 50');
  });
  it('offers explicit details within the same hard output ceiling', async () => {
    state.prompts = [{ searchable_text: '[System: inbox] explicit history', metadata: null }];
    const text = await handleGetSessionSummary('s1', 's1', root, true);
    expect(text).toContain('explicit history');
    state.prompts[0].searchable_text = '界'.repeat(30_000);
    const large = await handleGetSessionSummary('s1', 's1', root, true);
    expectBounded(large);
    expect(await fullOutput(large)).toContain(state.prompts[0].searchable_text);
  });
});


describe('output budget boundaries', () => {
  it('leaves exact byte and line boundaries unchanged', async () => {
    const bytes = '界'.repeat(8000);
    expect(await boundSessionOutput(bytes)).toBe(bytes);
    const lines = Array(100).fill('line').join('\n');
    expect(await boundSessionOutput(lines)).toBe(lines);
  });
  it('enforces both ceilings including recovery instructions and Unicode content', async () => {
    for (const full of ['界'.repeat(8001), Array(101).fill('line').join('\n'), '😀'.repeat(10_000)]) {
      const text = await boundSessionOutput(full);
      expectBounded(text);
      expect(text).not.toContain('\uFFFD');
      expect(await fullOutput(text)).toBe(full);
    }
  });
});

it('retains missing ancestors, external repositories, URIs and legacy paths without inventing cwd-based identities', async () => {
  const paths = await uniqueSessionFilePaths([
    { workspaceId: root, filePath: 'removed/sub/file.ts' },
    { workspaceId: root, filePath: './removed/sub/file.ts' },
    { workspaceId: root, filePath: join(root, 'other-checkout', 'file.ts') },
    { filePath: 'legacy/./file.ts' },
    { filePath: 'collab://org:test:doc:deleted' },
  ]);
  expect(paths).toEqual([
    join(root, 'removed/sub/file.ts'), join(root, 'other-checkout/file.ts'),
    'legacy/file.ts', 'collab://org:test:doc:deleted',
  ]);
});
