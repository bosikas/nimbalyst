import React, { useState } from 'react';
import { useAtomValue } from 'jotai';
import { FloatingPortal, useFloatingMenu } from '../hooks/useFloatingMenu';
import { refreshVibeUsage, vibeUsageAtom } from '../store/listeners/vibeUsageListeners';
import { UsageRing } from './common/UsageRing';

export function VibeUsageIndicator({ onRefresh = refreshVibeUsage }: { onRefresh?: () => Promise<void> }) {
  const usage = useAtomValue(vibeUsageAtom);
  const [open, setOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const menu = useFloatingMenu({ placement: 'right-end', open, onOpenChange: setOpen });
  const percent = usage?.utilization ?? null;
  const stroke = percent === null ? 'stroke-nim-tertiary'
    : percent >= 90 ? 'stroke-red-500' : percent >= 70 ? 'stroke-yellow-500' : 'stroke-green-500';

  async function refresh() {
    setRefreshing(true);
    try { await onRefresh(); } finally { setRefreshing(false); }
  }

  return <div className="relative">
    <button type="button" ref={menu.refs.setReference} onClick={() => setOpen(!open)}
      title={percent === null ? 'Mistral Vibe usage unavailable' : `Mistral Vibe usage: ${Math.round(percent)}%`}
      aria-label="Mistral Vibe Usage" aria-expanded={open}
      className="relative flex size-9 items-center justify-center rounded-md p-0 hover:bg-nim-tertiary">
      <UsageRing percent={percent} strokeColor={stroke} />
    </button>
    {open && <FloatingPortal>
      <div ref={menu.refs.setFloating} style={menu.floatingStyles} {...menu.getFloatingProps()}
        className="z-50 w-64 max-w-[calc(100vw-16px)] rounded-lg border border-nim bg-nim-secondary p-3 text-sm text-nim shadow-lg">
        <div className="flex items-center justify-between gap-2">
          <h2 className="font-semibold">Mistral Vibe Usage</h2>
          <button type="button" onClick={() => void refresh()} disabled={refreshing} className="text-nim-accent">
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
        <p className="mt-2 text-nim-muted">{percent === null
          ? 'Vibe didn’t report a monthly allowance.'
          : `${Math.round(percent)}% of the monthly allowance used`}</p>
        {usage?.resetsAt && <p className="mt-1 text-nim-muted">Resets {new Date(usage.resetsAt).toLocaleString()}</p>}
      </div>
    </FloatingPortal>}
  </div>;
}
