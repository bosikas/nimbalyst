import { MistralVibeProvider } from '@nimbalyst/runtime/ai/server';
import type { VibeUsageData } from '../../shared/browserHost';

const pollingIntervalMs = 60_000;
let cached: VibeUsageData = null;
let refreshedAt = 0;
let pending: Promise<VibeUsageData> | undefined;

export function readVibeUsage(refresh = false): Promise<VibeUsageData> {
  if (pending) return pending;
  if (!refresh && Date.now() - refreshedAt < pollingIntervalMs) return Promise.resolve(cached);
  pending = MistralVibeProvider.readAccountUsage().then((usage) => {
    cached = usage;
    refreshedAt = Date.now();
    return usage;
  }).finally(() => { pending = undefined; });
  return pending;
}
