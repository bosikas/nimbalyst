import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';

type SessionUsage = SessionData['tokenUsage'];

interface SavedProjection {
  session_id?: string;
  snapshot?: {
    session?: {
      contextUsage?: { totalTokens?: unknown };
      tokenUsage?: { inputTokens?: unknown; outputTokens?: unknown; totalTokens?: unknown; cachedInputTokens?: unknown };
    };
  };
}

interface SavedRuntime {
  session_id?: string;
  core_settings?: { context?: { model_facts?: { compaction_threshold?: unknown } } };
}

async function readSnapshot<T>(path: string): Promise<T | undefined> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return undefined;
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8')) as T;
  } finally {
    await handle.close();
  }
}

function tokenCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Recover Vibe's last saved reading for sessions that have no Nimbalyst usage record. */
export async function readSessionTokenUsageForDisplay(
  { provider, providerSessionId, tokenUsage }: Pick<SessionData, 'provider' | 'providerSessionId' | 'tokenUsage'>,
): Promise<SessionUsage> {
  if (tokenUsage || provider !== 'mistral-vibe' || !providerSessionId ||
      !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(providerSessionId)) return tokenUsage;

  try {
    const vibeHome = process.env.VIBE_HOME || join(homedir(), '.vibe');
    const dir = join(vibeHome, 'logs', 'session', 'unified', providerSessionId);
    const current = await readSnapshot<{ generation?: string }>(join(dir, 'CURRENT'));
    if (typeof current?.generation !== 'string' || !/^\d{16}$/.test(current.generation)) return undefined;
    const generation = join(dir, 'generations', current.generation);
    const [runtime, projection] = await Promise.all([
      readSnapshot<SavedRuntime>(join(generation, 'runtime-state.json')),
      readSnapshot<SavedProjection>(join(generation, 'projection-state.json')),
    ]);
    if (runtime?.session_id !== providerSessionId || projection?.session_id !== providerSessionId) return undefined;

    // The native ACP meter uses the compaction threshold as its denominator.
    const contextWindow = runtime.core_settings?.context?.model_facts?.compaction_threshold;
    const session = projection.snapshot?.session;
    const contextTokens = session?.contextUsage?.totalTokens;
    const totals = session?.tokenUsage;
    const input = totals?.inputTokens;
    const output = totals?.outputTokens;
    const total = totals?.totalTokens;
    const cached = totals?.cachedInputTokens ?? 0;
    if (!tokenCount(contextWindow) || contextWindow === 0 || !tokenCount(contextTokens) ||
        !tokenCount(input) || !tokenCount(output) || !tokenCount(total) || !tokenCount(cached) || cached > input) return undefined;

    return {
      inputTokens: input - cached,
      outputTokens: output,
      totalTokens: total,
      cacheReadInputTokens: cached,
      contextWindow,
      currentContext: { tokens: contextTokens, contextWindow },
    };
  } catch {
    // A missing checkpoint or one being replaced can be read on the next request.
    return undefined;
  }
}
