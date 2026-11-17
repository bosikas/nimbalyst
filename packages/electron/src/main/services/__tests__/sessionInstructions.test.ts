import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { snapshotSessionInstructions } from '../sessionInstructions';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), 'session-instructions-'));
  directories.push(dir);
  await writeFile(path.join(dir, 'reviewer.md'), 'Review changes. Never implement fixes.');
  return dir;
}

describe('session instruction selection at creation', () => {
  it('keeps existing defaults and never inherits a caller snapshot', async () => {
    expect(await snapshotSessionInstructions({ instructionSnapshot: { content: 'Parent profile' } } as any, '/unused', 'openai-codex')).toEqual({ skipDefaultInstructions: false, instructionSnapshot: null });
  });
  it('freezes a complete custom file, with explicit independent default exclusion', async () => {
    const dir = await fixture();
    const snapshot = await snapshotSessionInstructions({ instructionFile: 'reviewer.md', skipDefaultInstructions: true }, dir, 'openai-codex');
    await writeFile(path.join(dir, 'reviewer.md'), 'Changed later');
    expect(snapshot.skipDefaultInstructions).toBe(true);
    expect(snapshot.instructionSnapshot?.content).toBe('Review changes. Never implement fixes.');
    expect(snapshot.instructionSnapshot?.path).toBe(await import('node:fs/promises').then(fs => fs.realpath(path.join(dir, 'reviewer.md'))));
    expect(snapshot.instructionSnapshot?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect((await snapshotSessionInstructions({ instructionFile: 'reviewer.md', skipDefaultInstructions: false }, dir, 'claude-code')).skipDefaultInstructions).toBe(false);
  });
  it('rejects unreadable files, directories, empty content and excessive UTF-8 bytes before creation', async () => {
    const dir = await fixture();
    await expect(snapshotSessionInstructions({ instructionFile: 'missing.md' }, dir, 'openai-codex')).rejects.toThrow();
    await expect(snapshotSessionInstructions({ instructionFile: dir }, dir, 'openai-codex')).rejects.toThrow();
    await writeFile(path.join(dir, 'empty.md'), '  ');
    await expect(snapshotSessionInstructions({ instructionFile: 'empty.md' }, dir, 'openai-codex')).rejects.toThrow(/empty/i);
    await writeFile(path.join(dir, 'large.md'), 'é'.repeat(12001));
    await expect(snapshotSessionInstructions({ instructionFile: 'large.md' }, dir, 'openai-codex')).rejects.toThrow(/24,000/);
  });
  it('fails explicitly for unsupported providers and invalid options', async () => {
    await expect(snapshotSessionInstructions({ skipDefaultInstructions: true }, '/unused', 'gemini')).rejects.toThrow(/support/i);
    await expect(snapshotSessionInstructions({ skipDefaultInstructions: 'false' } as any, '/unused', 'openai-codex')).rejects.toThrow(/boolean/);
    await expect(snapshotSessionInstructions({ instructionFile: 7 } as any, '/unused', 'openai-codex')).rejects.toThrow(/string/);
  });
});
