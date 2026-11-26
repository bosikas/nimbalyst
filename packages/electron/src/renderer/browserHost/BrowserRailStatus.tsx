import React, { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'jotai';
import type { BrowserHostRailStatus, BrowserUsageProvider } from '../../shared/browserHost';
import { ClaudeUsageIndicator } from '../components/ClaudeUsageIndicator';
import { CodexUsageIndicator } from '../components/CodexUsageIndicator';
import { GeminiUsageIndicator } from '../components/GeminiUsageIndicator';
import { VibeUsageIndicator } from '../components/VibeUsageIndicator';
import { claudeUsageAtom } from '../store/atoms/claudeUsageAtoms';
import { codexUsageAtom } from '../store/atoms/codexUsageAtoms';
import { geminiUsageAtom } from '../store/atoms/geminiUsageAtoms';
import { vibeUsageAtom } from '../store/listeners/vibeUsageListeners';
import { useBrowserRefresh } from './useBrowserRefresh';
import { prunePanelGutterBadges, setPanelGutterBadge } from '../extensions/panels/panelGutterBadges';

type Request = (path: string, init?: RequestInit) => Promise<Response>;

export function useBrowserRailStatus(request: Request) {
  const store = useStore();
  const lastApplied = useRef(0);
  const sequence = useRef(0);
  const previousBadges = useRef<BrowserHostRailStatus['badges']>({});

  useEffect(() => () => {
    previousBadges.current = {};
    lastApplied.current = ++sequence.current;
    prunePanelGutterBadges(new Set());
  }, [request]);

  const load = useCallback(async (signal?: AbortSignal, refresh?: BrowserUsageProvider) => {
    const generation = ++sequence.current;
    const path = refresh ? `/rail-status?refresh=${refresh}` : '/rail-status';
    const response = await request(path, { signal });
    const snapshot: BrowserHostRailStatus = await response.json();
    return { generation, snapshot };
  }, [request]);

  const apply = useCallback(({ generation, snapshot }: Awaited<ReturnType<typeof load>>) => {
    if (generation <= lastApplied.current) return;
    lastApplied.current = generation;
    store.set(claudeUsageAtom, snapshot.claude);
    store.set(codexUsageAtom, snapshot.codex);
    store.set(geminiUsageAtom, snapshot.gemini);
    store.set(vibeUsageAtom, snapshot.vibe);
    const badges = snapshot.badges;
    for (const panelId of Object.keys(previousBadges.current)) {
      if (!Object.hasOwn(badges, panelId)) setPanelGutterBadge(panelId, null);
    }
    for (const [panelId, badge] of Object.entries(badges)) {
      const previous = previousBadges.current[panelId];
      if (badge.count !== previous?.count || badge.tone !== previous.tone) {
        setPanelGutterBadge(panelId, badge.count, badge.tone);
      }
    }
    previousBadges.current = badges;
  }, [store]);

  useBrowserRefresh(load, apply, 5_000);
  const refresh = useCallback(async (provider: BrowserUsageProvider) => {
    try { apply(await load(undefined, provider)); } catch { /* Keep the last reading. */ }
  }, [load, apply]);
  return refresh;
}

export function BrowserUsageIndicators({ refresh }: { refresh: (provider: BrowserUsageProvider) => Promise<void> }) {
  return <div className="browser-host-usage" aria-label="Provider usage">
    <ClaudeUsageIndicator onRefresh={() => refresh('claude')} />
    <CodexUsageIndicator onRefresh={() => refresh('codex')} />
    <GeminiUsageIndicator onRefresh={() => refresh('gemini')} />
    <VibeUsageIndicator onRefresh={() => refresh('vibe')} />
  </div>;
}
