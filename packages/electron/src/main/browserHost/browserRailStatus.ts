import type { BrowserHostRailStatus, BrowserUsageProvider } from '../../shared/browserHost';
import { listBackendPanelGutterBadges } from '../extensions/backendPanelBadges';
import { claudeUsageService } from '../services/ClaudeUsageService';
import { codexUsageService } from '../services/CodexUsageService';
import { geminiUsageService } from '../services/GeminiUsageService';
import { readVibeUsage } from '../services/VibeUsageService';

export async function readBrowserRailStatus(
  workspacePaths: readonly string[], refresh?: BrowserUsageProvider,
): Promise<BrowserHostRailStatus> {
  const badges: BrowserHostRailStatus['badges'] = Object.fromEntries(
    listBackendPanelGutterBadges().flatMap(({ workspacePath, panelId, value, tone }) =>
      workspacePaths.includes(workspacePath) && value !== null
        ? [[panelId, { count: value, tone }]] : []),
  );
  const [claude, codex, gemini, vibe] = await Promise.all([
    readUsage(claudeUsageService, refresh === 'claude'),
    readUsage(codexUsageService, refresh === 'codex'),
    readUsage(geminiUsageService, refresh === 'gemini'),
    readVibeUsage(refresh === 'vibe').catch(() => null),
  ]);
  return { badges, claude, codex, gemini, vibe };
}

async function readUsage<T>(service: { getCachedUsage(): T | null; refresh(): Promise<T> }, refresh: boolean) {
  const cached = service.getCachedUsage();
  return !refresh && cached ? cached : service.refresh().catch(() => cached);
}
