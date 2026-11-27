import { MistralVibeProvider } from '@nimbalyst/runtime/ai/server';
import type { VibeUsageData } from '../../shared/browserHost';

const pollingIntervalMs = 60_000;
const staleGraceMs = 5 * 60_000;
let cached: { usage: NonNullable<VibeUsageData>; expiresAt: number } | undefined;
let refreshedAt = 0;
let pending: Promise<VibeUsageData> | undefined;

export function readVibeUsage(refresh = false): Promise<VibeUsageData> {
  if (pending) return pending;
  const now = Date.now();
  if (!refresh && now - refreshedAt < pollingIntervalMs && (!cached || now < cached.expiresAt)) {
    return Promise.resolve(cached?.usage ?? null);
  }
  pending = MistralVibeProvider.readAccountUsage().catch(() => null).then((usage) => {
    refreshedAt = Date.now();
    if (usage) {
      const resetAt = usage.resetsAt === null ? Infinity : Date.parse(usage.resetsAt);
      cached = { usage, expiresAt: Math.min(refreshedAt + staleGraceMs, resetAt) };
    }
    if (cached && refreshedAt >= cached.expiresAt) cached = undefined;
    return cached?.usage ?? null;
  }).finally(() => { pending = undefined; });
  return pending;
}
