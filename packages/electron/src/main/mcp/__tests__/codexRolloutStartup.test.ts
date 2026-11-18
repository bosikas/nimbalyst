// @vitest-environment node
import { execFileSync } from 'child_process';
import { constants } from 'fs';
import { mkdir, mkdtemp, open, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it, vi } from 'vitest';

// FileHandle is not exported by name; take its prototype from a real handle.
const FileHandle = await (async () => { const handle = await open(process.execPath, 'r'); await handle.close(); return handle.constructor as any; })();
import { codexRolloutDayCandidates } from '@nimbalyst/runtime/ai/server/providers/codex/codexRecordedStartup';
import { readCodexRecordedStartup, readCodexStartupPrefix } from '../codexRolloutStartup';

const threadId = '01a1e854-46b0-7841-8b38-ab675abe8881';
const record = (text: string, kinds: string[]) => ({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } });
const baseline = record('You are Codex.', ['model.base_instructions']);
const task = record('Investigate.', ['user.text']);

async function fixture(lines: string[]) {
  const home = await mkdtemp(join(tmpdir(), 'codex-home-'));
  const day = join(home, 'sessions', ...codexRolloutDayCandidates(threadId)![0]);
  await mkdir(day, { recursive: true });
  const file = join(day, `rollout-2026-11-17T09-06-39-${threadId}.jsonl`);
  await writeFile(file, lines.join('\n'));
  return { home, file };
}

describe('Codex rollout startup reader', () => {
  it('locates the rollout by thread id, stops at the opening input and fingerprints content', async () => {
    const { home } = await fixture([JSON.stringify({ type: 'session_meta', payload: { id: threadId } }), JSON.stringify(baseline), JSON.stringify(task), '{not json after the boundary']);
    const report = await readCodexRecordedStartup(threadId, home);
    expect(report?.messages.map(m => m.line)).toEqual([2, 3]);
    expect(report?.messages[0].sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report?.source).toContain(threadId);
    expect(await readCodexRecordedStartup('01a1e854-0000-7000-8000-000000000000', home)).toBeNull();
    await expect(readCodexRecordedStartup('../escape', home)).rejects.toThrow(/thread id/);
  });

  it('rejects a rollout whose recorded session is another thread, and symlinked rollouts', async () => {
    const { home, file } = await fixture([JSON.stringify({ type: 'session_meta', payload: { id: '01a1e854-ffff-7000-8000-000000000000' } }), JSON.stringify(task)]);
    await expect(readCodexRecordedStartup(threadId, home)).rejects.toThrow(/does not match/);
    const other = await fixture([JSON.stringify({ type: 'session_meta', payload: { id: threadId } }), JSON.stringify(task)]);
    await rm(file);
    await symlink(other.file, file);
    await expect(readCodexRecordedStartup(threadId, home)).rejects.toThrow(/regular file/);
  });

  it.skipIf(process.platform === 'win32')('rejects a FIFO promptly instead of blocking on open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-fifo-'));
    const fifo = join(dir, 'rollout.jsonl');
    execFileSync('mkfifo', [fifo]);
    const outcome = readCodexStartupPrefix(fifo).then(() => 'resolved', (error: Error) => error.message);
    const timedOut = new Promise(resolve => setTimeout(() => resolve('blocked'), 1000));
    try {
      expect(await Promise.race([outcome, timedOut])).toMatch(/regular file/);
    } finally {
      // Release a blocked reader, if any, so the worker can exit.
      const writer = await open(fifo, constants.O_WRONLY | constants.O_NONBLOCK).catch(() => null);
      await writer?.close();
    }
  });

  it('reads at most the cap plus one byte and still accepts a prefix that ends before later large history', async () => {
    const { file } = await fixture([JSON.stringify(baseline), JSON.stringify(task), 'y'.repeat(50_000)]);
    expect(await readCodexStartupPrefix(file, 600)).toHaveLength(2);
    const huge = await fixture(['x'.repeat(3_000_000)]);
    const reads: number[] = [];
    const original = FileHandle.prototype.read;
    const spy = vi.spyOn(FileHandle.prototype, 'read').mockImplementation(function (this: unknown, ...args: any[]) {
      return (original as any).apply(this, args).then((result: { bytesRead: number }) => { reads.push(result.bytesRead); return result; });
    });
    try {
      await expect(readCodexStartupPrefix(huge.file, 1000)).rejects.toThrow(/exceeds/);
    } finally {
      spy.mockRestore();
    }
    expect(reads.reduce((sum, n) => sum + n, 0)).toBeLessThanOrEqual(1001);
  });

  it('fails fast on malformed records and on an oversized prefix instead of truncating', async () => {
    const { file } = await fixture([JSON.stringify(baseline), '{broken', JSON.stringify(task)]);
    await expect(readCodexStartupPrefix(file)).rejects.toThrow(/line 2 is not valid JSON/);
    const large = await fixture([JSON.stringify(record('x'.repeat(2000), ['model.base_instructions'])), JSON.stringify(task)]);
    await expect(readCodexStartupPrefix(large.file, 1000)).rejects.toThrow(/exceeds/);
  });
});
