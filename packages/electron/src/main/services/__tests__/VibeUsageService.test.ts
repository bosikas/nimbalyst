// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';

const { readAccountUsage } = vi.hoisted(() => ({ readAccountUsage: vi.fn() }));
vi.mock('@nimbalyst/runtime/ai/server', () => ({ MistralVibeProvider: { readAccountUsage } }));

afterEach(() => {
  vi.useRealTimers();
  vi.resetModules();
  readAccountUsage.mockReset();
});

it('keeps a recent allowance during a failed refresh until the grace period expires', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-12-15T12:00:00Z'));
  const usage = { utilization: 23.4, resetsAt: '2027-01-01T00:00:00Z' };
  readAccountUsage.mockResolvedValueOnce(usage).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'));
  const { readVibeUsage } = await import('../VibeUsageService');

  expect(await readVibeUsage()).toEqual(usage);
  expect(await readVibeUsage(true)).toEqual(usage);
  expect(await readVibeUsage(true)).toEqual(usage);

  vi.advanceTimersByTime(5 * 60_000);
  readAccountUsage.mockResolvedValue(null);
  expect(await readVibeUsage()).toBeNull();
});

it('drops a cached allowance at its monthly reset', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-12-31T23:59:50Z'));
  const usage = { utilization: 98, resetsAt: '2027-01-01T00:00:00Z' };
  readAccountUsage.mockResolvedValueOnce(usage).mockResolvedValue(null);
  const { readVibeUsage } = await import('../VibeUsageService');

  expect(await readVibeUsage()).toEqual(usage);
  vi.advanceTimersByTime(10_000);
  expect(await readVibeUsage()).toBeNull();
});
