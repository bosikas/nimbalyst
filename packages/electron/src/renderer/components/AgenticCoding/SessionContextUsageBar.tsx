import React, { memo, useMemo } from 'react';
import { atom, useAtomValue } from 'jotai';
import { agentCapabilitiesForProviderType } from '@nimbalyst/runtime/ai/server/agentCapabilities';
import {
  contextUsageLevel,
  contextUsagePercent,
  readSessionContextUsage,
} from '@nimbalyst/runtime/ai/sessionContextUsage';
import { sessionRegistryAtom, sessionTokenUsageAtom } from '../../store/atoms/sessions';
import { showContextUsageAtom } from '../../store/atoms/agentMode';

const FILL_COLORS = {
  normal: 'var(--nim-primary)',
  warning: 'var(--nim-warning)',
  critical: 'var(--nim-error)',
} as const;

function formatTokensShort(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
  return tokens.toString();
}

/**
 * Context-window fill under a session row's title. Owns its subscriptions so
 * a token update re-renders only this bar, not the row or its siblings.
 */
export const SessionContextUsageBar = memo(function SessionContextUsageBar({ sessionId, variant = 'bar' }: { sessionId: string; variant?: 'bar' | 'details' }) {
  const enabled = useAtomValue(showContextUsageAtom);
  // Primitives, so a registry refresh that rebuilds entries does not re-render unchanged bars.
  const provider = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.provider), [sessionId]));
  const storedTokens = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.contextUsage?.tokens), [sessionId]));
  const storedWindow = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.contextUsage?.contextWindow), [sessionId]));
  // A loaded session's in-memory usage is newer than the list snapshot and
  // updates mid-turn; when it is present it wins, including a cleared snapshot after compaction.
  const liveTokenUsage = useAtomValue(sessionTokenUsageAtom(sessionId));

  if (!enabled && variant !== 'details') return null;
  if (agentCapabilitiesForProviderType(provider).contextReporting !== 'context-window') return variant !== 'bar'
    ? <span className="session-context-usage-unknown" title="Context-window usage is not reported by this provider">Context —</span> : null;
  const usage = liveTokenUsage
    ? readSessionContextUsage(liveTokenUsage)
    : readSessionContextUsage({ currentContext: { tokens: storedTokens, contextWindow: storedWindow } });
  if (!usage) return variant !== 'bar'
    ? <span className="session-context-usage-unknown" title="No current context-window measurement reported">Context —</span> : null;

  const percent = contextUsagePercent(usage);
  const level = contextUsageLevel(percent);
  const label = `Context ${formatTokensShort(usage.tokens)} / ${formatTokensShort(usage.contextWindow)} (${percent}%)`;
  const exactLabel = `Context: ${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens (${percent}%)`;

  if (variant === 'details') return <span>{exactLabel}</span>;

  return (
    <div
      className={`session-context-usage-bar usage-${level} h-0.5 mt-0.5 rounded-full overflow-hidden bg-[var(--nim-bg-tertiary)]`}
      title={label}
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.min(percent, 100)}
    >
      <div
        className="session-context-usage-fill h-full rounded-full"
        style={{ width: `${Math.min(percent, 100)}%`, backgroundColor: FILL_COLORS[level] }}
      />
    </div>
  );
});
