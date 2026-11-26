import { atom } from 'jotai';
import type { VibeUsageData } from '../../../shared/browserHost';
import { store } from '../index';

export const vibeUsageAtom = atom<VibeUsageData>(null);

export async function refreshVibeUsage(refresh = true): Promise<void> {
  try {
    const usage = await window.electronAPI.invoke(refresh ? 'vibe-usage:refresh' : 'vibe-usage:get');
    store.set(vibeUsageAtom, usage as VibeUsageData);
  } catch {
    // Keep the most recent reading if the host is temporarily unavailable.
  }
}

export function initVibeUsageListeners(): () => void {
  void refreshVibeUsage(false);
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void refreshVibeUsage(false);
  }, 60_000);
  return () => window.clearInterval(timer);
}
