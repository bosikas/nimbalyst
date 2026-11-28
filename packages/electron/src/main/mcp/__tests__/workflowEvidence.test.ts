import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { readWorkflowEvidence, readWorkflowSkill, recordWorkflowCheckpoint } from '../workflowEvidence';

vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({
  AISessionsRepository: { get: vi.fn() },
}));

let directory: string;
let worktree: string;
let session: NonNullable<Awaited<ReturnType<typeof AISessionsRepository.get>>>;
const skill = '# Coordinate\n' + 'Load the full procedure before acting.\n'.repeat(32);

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'workflow-evidence-'));
  const workspace = join(directory, 'project');
  worktree = join(directory, 'worktree');
  await mkdir(workspace);
  await mkdir(join(worktree, '.agents/skills/coordinate'), { recursive: true });
  await writeFile(join(worktree, '.agents/skills/coordinate/SKILL.md'), skill);
  vi.stubEnv('XDG_STATE_HOME', directory);
  session = { id: 'local', provider: 'mistral-vibe', providerSessionId: 'native', workspacePath: workspace, worktreePath: worktree } as typeof session;
  vi.mocked(AISessionsRepository.get).mockResolvedValue(session);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

describe('managed workflow evidence', () => {
  it('records an entire skill and verifies its exact revision at the checkpoint', async () => {
    expect(await recordWorkflowCheckpoint(session.id, session.workspacePath!, 'coordinate')).toBe(false);
    const read = (offset?: number) => readWorkflowSkill(session.id, session.workspacePath!, 'coordinate', offset);
    let page = await read();
    expect(page.nextOffset).not.toBeNull();
    expect((await readWorkflowEvidence(session, false)).skillReceipts.map(item => item.result)).toEqual(['checkpoint']);
    await expect(read(page.nextOffset! + 1)).rejects.toThrow('page was skipped');
    let text = page.text;
    while (page.nextOffset !== null) {
      page = await read(page.nextOffset);
      text += page.text;
    }
    expect(text).toBe(skill);
    expect(await recordWorkflowCheckpoint(session.id, session.workspacePath!, 'coordinate')).toBe(true);
    await writeFile(join(worktree, '.agents/skills/coordinate/SKILL.md'), skill + 'Different instructions.');
    expect(await recordWorkflowCheckpoint(session.id, session.workspacePath!, 'coordinate')).toBe(false);
  });

  it('rejects a skill symlink outside this worktree and its managed profile', async () => {
    const secret = join(directory, 'foreign.md');
    await writeFile(secret, 'outside');
    await mkdir(join(worktree, '.agents/skills/deliver'));
    await symlink(secret, join(worktree, '.agents/skills/deliver/SKILL.md'));
    await expect(readWorkflowSkill(session.id, session.workspacePath!, 'deliver', 0)).rejects.toThrow();
    await expect(readWorkflowSkill(session.id, directory, 'coordinate', 0)).rejects.toThrow('in this workspace');
  });

  it('finds duplicated instruction sections and matches native hook receipts by session', async () => {
    const paragraph = 'A common instruction long enough to be a duplicated section.';
    await writeFile(join(session.workspacePath!, 'AGENTS.md'), paragraph);
    await writeFile(join(worktree, 'AGENTS.md'), paragraph);
    const hooks = join(directory, 'ai-setup', 'hook-receipts');
    await mkdir(hooks, { recursive: true });
    const key = createHash('sha256').update('vibe\0native').digest('hex');
    await writeFile(join(hooks, key + '.jsonl'), JSON.stringify({
      name: 'pre-shell', worktree, result: 'blocked', reason: 'Hook returned a blocking decision',
      timestamp: '2026-11-28T00:00:00.000Z',
    }) + '\n');
    const evidence = await readWorkflowEvidence(session, false);
    expect(evidence.duplicates).toBe(1);
    expect(evidence.hookStatus).toBe('observed');
    expect(evidence.hookReceipts[0]).toMatchObject({ name: 'pre-shell', result: 'blocked', worktree });
    expect((await readWorkflowEvidence({ ...session, providerSessionId: 'other' }, false)).hookReceipts).toEqual([]);
  });
});
