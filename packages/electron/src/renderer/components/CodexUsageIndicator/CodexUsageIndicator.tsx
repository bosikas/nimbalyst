/**
 * CodexUsageIndicator - Circular progress indicator for Codex usage
 *
 * Displays the most constrained active Codex limit as a circular progress
 * ring in the navigation gutter. Clicking opens a popover with full details.
 * Error states render as a blank ("--") indicator with hover details.
 */

import React, { useState, useRef, useCallback } from 'react';
import { useAtomValue } from 'jotai';
import {
  codexUsageAtom,
  codexUsageAvailableAtom,
  codexUsageIndicatorColorAtom,
  codexUsageMostConstrainedWindowAtom,
  formatCodexWindowLabel,
  formatResetTime,
} from '../../store/atoms/codexUsageAtoms';
import { CodexUsagePopover } from './CodexUsagePopover';
import { refreshCodexUsage } from '../../store/listeners/codexUsageListeners';
import { UsageRing } from '../common/UsageRing';

interface CodexUsageIndicatorProps {
  className?: string;
  onRefresh?: () => Promise<void>;
}

export const CodexUsageIndicator: React.FC<CodexUsageIndicatorProps> = ({ className, onRefresh }) => {
  const usage = useAtomValue(codexUsageAtom);
  const isAvailable = useAtomValue(codexUsageAvailableAtom);
  const indicatorColor = useAtomValue(codexUsageIndicatorColorAtom);
  const mostConstrained = useAtomValue(codexUsageMostConstrainedWindowAtom);

  const [isPopoverOpen, setIsPopoverOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClick = useCallback(() => {
    setIsPopoverOpen((prev) => !prev);
  }, []);

  const handleRefresh = useCallback(async () => {
    await (onRefresh ?? refreshCodexUsage)();
  }, [onRefresh]);

  if (!isAvailable) {
    return null;
  }

  const hasLoadError = Boolean(usage?.error);
  const utilization = hasLoadError ? 0 : mostConstrained?.window.usedPercent ?? 0;
  const limitsAvailable = !hasLoadError && Boolean(mostConstrained);

  const colorClasses: Record<string, string> = {
    green: 'stroke-green-500',
    yellow: 'stroke-yellow-500',
    red: 'stroke-red-500',
    muted: 'stroke-nim-muted',
  };

  const effectiveIndicatorColor = limitsAvailable ? indicatorColor : 'muted';
  const strokeColor = colorClasses[effectiveIndicatorColor] || colorClasses.muted;

  const constrainedLabel = mostConstrained
    ? [mostConstrained.limit.name, formatCodexWindowLabel(mostConstrained.window)]
        .filter(Boolean)
        .join(' · ')
    : null;

  const tooltipContent = usage?.error
    ? `Codex usage unavailable: ${usage.error}`
    : usage
      ? limitsAvailable
        ? `Codex ${constrainedLabel}: ${Math.round(utilization)}% (resets ${formatResetTime(mostConstrained?.window.resetsAt ?? null)})`
        : 'Codex usage (limits unavailable)'
      : 'Codex usage unavailable';

  return (
    <div className={`relative ${className || ''}`}>
      <button
        ref={buttonRef}
        onClick={handleClick}
        title={tooltipContent}
        className="relative w-9 h-9 flex items-center justify-center bg-transparent border-none rounded-md cursor-pointer transition-all duration-150 p-0 hover:bg-nim-tertiary active:scale-95 focus-visible:outline-2 focus-visible:outline-[var(--nim-primary)] focus-visible:outline-offset-2"
        aria-label="Codex Usage"
        data-testid="codex-usage-indicator"
      >
        <UsageRing percent={limitsAvailable ? utilization : null} strokeColor={strokeColor} />
      </button>

      {isPopoverOpen && (
        <CodexUsagePopover
          anchorRef={buttonRef}
          onClose={() => setIsPopoverOpen(false)}
          onRefresh={handleRefresh}
          canDisable={!onRefresh}
        />
      )}
    </div>
  );
};
