// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readSessionTokenUsageForDisplay } from '../vibeSessionTokenUsage';

const providerSessionId = '00000000-1111-2222-3333-444444444444';
const session = { provider: 'mistral-vibe', providerSessionId };
const generation = '0000000000001294';
let vibeHome: string;
let snapshotDir: string;

beforeEach(async () => {
  vibeHome = await mkdtemp(join(tmpdir(), 'vibe-saved-usage-'));
  vi.stubEnv('VIBE_HOME', vibeHome);
  const sessionDir = join(vibeHome, 'logs', 'session', 'unified', providerSessionId);
  snapshotDir = join(sessionDir, 'generations', generation);
  await mkdir(snapshotDir, { recursive: true });
  await writeFile(join(sessionDir, 'CURRENT'), JSON.stringify({ generation }));
  await writeFile(join(snapshotDir, 'runtime-state.json'), JSON.stringify({
    session_id: providerSessionId,
    core_settings: { context: { model_facts: { compaction_threshold: 400_000, context_window: 1_048_576 } } },
  }));
  await writeFile(join(snapshotDir, 'projection-state.json'), JSON.stringify({
    session_id: providerSessionId,
    snapshot: { session: {
      contextUsage: { totalTokens: 91_459 },
      tokenUsage: { inputTokens: 948_191, outputTokens: 49_662, totalTokens: 997_853, cachedInputTokens: 690_048 },
    } },
  }));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(vibeHome, { recursive: true, force: true });
});

it('recovers current context and cumulative spend independently from the native checkpoint', async () => {
  expect(await readSessionTokenUsageForDisplay(session)).toEqual({
    inputTokens: 258_143,
    outputTokens: 49_662,
    totalTokens: 997_853,
    cacheReadInputTokens: 690_048,
    contextWindow: 400_000,
    currentContext: { tokens: 91_459, contextWindow: 400_000 },
  });
});

it('preserves usage already tracked by Nimbalyst', async () => {
  const tokenUsage = { inputTokens: 8, outputTokens: 2, totalTokens: 10 };
  expect(await readSessionTokenUsageForDisplay({ ...session, tokenUsage })).toBe(tokenUsage);
});

it('requires checkpoints for the correct session', async () => {
  await writeFile(join(snapshotDir, 'projection-state.json'), JSON.stringify({ session_id: 'other-session' }));
  expect(await readSessionTokenUsageForDisplay(session)).toBeUndefined();
});
