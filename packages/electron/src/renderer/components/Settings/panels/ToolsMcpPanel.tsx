import React, { useCallback, useEffect, useRef, useState } from 'react';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { ToggleSwitch } from '../../GlobalSettings/SettingsToggle';
import type { MeasurableToolSchema } from '@nimbalyst/runtime/ai/server/services/mcpTokenBudget';

/**
 * Tools & MCP settings panel — the single place that answers "which tool
 * groups can the agent load, and what does each cost in context tokens".
 *
 * Data comes from the main-process tool-budget snapshot
 * (`mcp-config:get-tool-budget` → toolBudgetService.ts), which measures the
 * same ListTools surfaces the unified MCP server serves. Rows consolidate the
 * existing opt-outs rather than adding new mechanisms: the Trackers toggle
 * writes the same per-workspace `trackersEnabled` state the tracker config
 * panel uses; extension and user-server rows link to their existing panels.
 */

type ToolGroupSource = 'core' | 'first-party' | 'extension' | 'user';

interface ToolGroupBudget {
  configKey: string;
  displayName: string;
  source: ToolGroupSource;
  loadPolicy: 'eager' | 'deferred' | 'conditional' | 'external';
  toolCount: number;
  estTokens: number | null;
  schemaBytes: number | null;
  inclusionReason: string;
  enabled: boolean;
  lockedOn: boolean;
  tools?: MeasurableToolSchema[];
}

interface ToolBudgetSnapshot {
  groups: ToolGroupBudget[];
  eagerEstTokens: number;
}

const GROUP_DESCRIPTIONS: Record<string, string> = {
  nimbalyst: 'Host glue the app needs (questions, commit proposal, screenshots, session metadata)',
  'nimbalyst-host': 'App settings, session context, and child-session orchestration',
  'nimbalyst-trackers': 'Bug, task, plan, and decision tracking',
  'nimbalyst-situational': 'Voice mode, collab documents, and feedback',
  'nimbalyst-extension-dev': 'Extension development and debugging (developer mode)',
};

function formatTokens(estTokens: number | null): string {
  if (estTokens === null) return '—';
  if (estTokens >= 1000) return `~${(estTokens / 1000).toFixed(1)}k`;
  return `~${estTokens}`;
}

function PolicyBadge({ policy }: { policy: ToolGroupBudget['loadPolicy'] }) {
  const label =
    policy === 'eager' ? 'Configured eager'
    : policy === 'conditional' ? 'Conditional'
    : policy === 'external' ? 'External'
    : 'Deferred discovery';
  const style =
    policy === 'eager'
      ? 'bg-[rgba(245,158,11,0.15)] text-[#F59E0B] border-[rgba(245,158,11,0.3)]'
      : 'bg-[var(--nim-bg-tertiary)] text-[var(--nim-text-muted)] border-[var(--nim-border)]';
  return (
    <span className={`policy-badge text-[10px] font-medium px-1.5 py-0.5 rounded border whitespace-nowrap ${style}`}>
      {label}
    </span>
  );
}

function TokenBadge({ estTokens }: { estTokens: number | null }) {
  return (
    <span
      className="token-badge text-[11px] tabular-nums text-[var(--nim-text-muted)] min-w-[48px] text-right"
      title={estTokens === null ? 'Tool definitions live in the external server; cost unknown until it connects' : 'Estimated context tokens when this group’s tool definitions are loaded'}
    >
      {formatTokens(estTokens)}
    </span>
  );
}

export function ToolsMcpPanel({
  workspacePath,
  onNavigateToCategory,
}: {
  workspacePath?: string;
  onNavigateToCategory?: (category: string) => void;
}) {
  const [snapshot, setSnapshot] = useState<ToolBudgetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [trackersEnabled, setTrackersEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    setSnapshot(null);
    setError(null);
    setSaving(false);
    async function loadSnapshot() {
      try {
        const result = await window.electronAPI.invoke('mcp-config:get-tool-budget', workspacePath, true);
        if (generation.current !== current) return;
        setSnapshot(result);
        const trackers = result?.groups?.find((g: ToolGroupBudget) => g.configKey === 'nimbalyst-trackers');
        if (trackers) setTrackersEnabled(trackers.enabled);
      } catch (err) {
        if (generation.current === current) setError(err instanceof Error ? err.message : 'Failed to load tool information');
      }
    }
    void loadSnapshot();
    return () => { generation.current++; };
  }, [workspacePath]);

  const handleTrackersToggle = useCallback(async (enabled: boolean) => {
    if (!workspacePath) return;
    const current = generation.current;
    setSaving(true);
    try {
      await window.electronAPI.invoke('workspace:update-state', workspacePath, {
        trackersEnabled: enabled,
      });
      if (generation.current !== current) return;
      setTrackersEnabled(enabled);
      setError(null);
    } catch (err) {
      if (generation.current === current) setError(err instanceof Error ? err.message : 'Could not save tool availability');
    } finally {
      if (generation.current === current) setSaving(false);
    }
  }, [workspacePath]);

  const groups = snapshot?.groups ?? [];
  const firstParty = groups.filter((g) => g.source === 'core' || g.source === 'first-party');
  const extensions = groups.filter((g) => g.source === 'extension');
  const userServers = groups.filter((g) => g.source === 'user');

  const renderRow = (group: ToolGroupBudget) => {
    const isTrackers = group.configKey === 'nimbalyst-trackers';
    const description =
      GROUP_DESCRIPTIONS[group.configKey] ??
      (group.source === 'extension' ? `${group.toolCount} tools from the ${group.displayName} extension` : 'User-added MCP server');
    const enabled = isTrackers ? trackersEnabled : group.enabled;

    return (
      <div
        key={group.configKey}
        className={`tool-group-row flex items-center justify-between gap-4 py-2.5 px-3 border-b border-[var(--nim-border)] last:border-b-0 ${enabled ? '' : 'opacity-55'}`}
        data-testid={`tool-group-${group.configKey}`}
      >
        <div className="tool-group-main min-w-0">
          <div className="tool-group-name flex items-center gap-1.5 text-sm font-medium text-[var(--nim-text)]">
            <span className="truncate">{group.displayName}</span>
            {group.lockedOn && (
              <MaterialSymbol
                icon="lock"
                size={13}
                className="text-[var(--nim-text-faint)]"
                title="Required — the app's own tools; cannot be disabled"
              />
            )}
            {isTrackers && workspacePath && (
              <span className="scope-chip text-[10px] px-1.5 py-px rounded bg-[var(--nim-bg-tertiary)] border border-[var(--nim-border)] text-[var(--nim-text-faint)]">
                This workspace
              </span>
            )}
          </div>
          <div className="tool-group-desc text-xs text-[var(--nim-text-muted)] truncate" title={group.inclusionReason}>{description}</div>
          <div className="text-[10px] text-[var(--nim-text-faint)]">{group.schemaBytes == null ? 'Schema bytes unavailable' : `${group.schemaBytes.toLocaleString()} UTF-8 schema bytes`} · estimate, not native usage</div>
          {group.tools && <details className="tool-group-schemas mt-2 text-xs">
            <summary className="cursor-pointer text-[var(--nim-link)]">Inspect {group.tools.length} tool definitions</summary>
            <p className="my-2 text-[var(--nim-text-muted)]">Configured definitions for this group. Session and document conditions can change the available tools. Individual exposure switches are managed by the native provider; execution permissions are separate.</p>
            {group.tools.map(tool => <details key={tool.name} className="tool-definition my-2">
              <summary className="cursor-pointer break-all font-mono">{tool.name}</summary>
              <p className="mt-1 whitespace-pre-wrap break-words text-[var(--nim-text-muted)]">{tool.description}</p>
              <pre aria-label={`Schema for ${tool.name}`} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--nim-bg)] p-2 select-text">{JSON.stringify(tool.inputSchema, null, 2) ?? 'No input schema supplied.'}</pre>
            </details>)}
          </details>}
        </div>
        <div className="tool-group-meta flex items-center gap-2.5 shrink-0">
          {group.toolCount > 0 && (
            <span className="tool-count text-[11px] text-[var(--nim-text-faint)] tabular-nums whitespace-nowrap">
              {group.toolCount} tools
            </span>
          )}
          <TokenBadge estTokens={group.estTokens} />
          <PolicyBadge policy={group.loadPolicy} />
          {group.lockedOn ? (
            <ToggleSwitch label={`${group.displayName} availability`} checked disabled onChange={() => undefined} />
          ) : isTrackers ? (
            <ToggleSwitch label={`${group.displayName} availability`} checked={trackersEnabled} onChange={enabled => void handleTrackersToggle(enabled)} disabled={!workspacePath || saving} />
          ) : group.source === 'extension' ? (
            <button
              className="manage-link text-xs text-[var(--nim-primary)] hover:underline whitespace-nowrap"
              onClick={() => onNavigateToCategory?.('installed-extensions')}
            >
              Manage
            </button>
          ) : group.source === 'user' ? (
            <button
              className="manage-link text-xs text-[var(--nim-primary)] hover:underline whitespace-nowrap"
              onClick={() => onNavigateToCategory?.('mcp-servers')}
            >
              Manage
            </button>
          ) : (
            // Non-toggleable first-party groups (host / situational / extension-dev):
            // deferred, so they cost nothing until the agent actually needs them.
            <span className="w-11" />
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="tools-mcp-panel max-w-[720px]">
      <h2 className="text-lg font-semibold text-[var(--nim-text)] mb-1">Tools &amp; MCP</h2>
      <p className="text-[13px] text-[var(--nim-text-muted)] mb-5">
        Inspect configured capabilities, measured schema text bytes and rough token estimates. These are not measurements of a native session&apos;s loaded context.
      </p>

      {error && (
        <div className="tools-mcp-error text-sm text-[var(--nim-error,#ff4444)] mb-4">{error}</div>
      )}
      {!snapshot && !error && <p role="status" className="mb-4 text-xs text-[var(--nim-text-muted)]">Loading tool definitions…</p>}

      {snapshot && (
        <div className="baseline-card flex items-start gap-3 py-3 px-4 mb-6 bg-[var(--nim-bg-secondary)] border border-[var(--nim-border)] rounded-lg">
          <MaterialSymbol icon="info" size={18} className="text-[var(--nim-text-muted)] mt-0.5 shrink-0" />
          <div className="text-[13px] text-[var(--nim-text)] leading-relaxed">
            Required Core interaction schemas estimate
            {' '}<span className="tabular-nums font-medium">{formatTokens(snapshot.eagerEstTokens)} tokens</span>.
            {' '}Other groups remain discoverable. Load-policy badges describe Nimbalyst&apos;s configured topology; the native client and model determine actual exposure. Estimates use roughly four text characters per token and do not partition the provider-reported usage in the AI panel.
          </div>
        </div>
      )}

      <div className="section-label text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] mb-2">
        Built-in tool groups
      </div>
      <div className="group-list border border-[var(--nim-border)] rounded-lg mb-6 bg-[var(--nim-bg-secondary)]">
        {firstParty.map(renderRow)}
      </div>

      {extensions.length > 0 && (
        <>
          <div className="section-label text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] mb-2">
            Extension tool groups
          </div>
          <div className="group-list border border-[var(--nim-border)] rounded-lg mb-6 bg-[var(--nim-bg-secondary)]">
            {extensions.map(renderRow)}
          </div>
        </>
      )}

      {userServers.length > 0 && (
        <>
          <div className="section-label text-[11px] font-semibold uppercase tracking-wide text-[var(--nim-text-faint)] mb-2">
            Your MCP servers <span className="normal-case font-normal">(.mcp.json)</span>
          </div>
          <div className="group-list border border-[var(--nim-border)] rounded-lg mb-6 bg-[var(--nim-bg-secondary)]">
            {userServers.map(renderRow)}
          </div>
        </>
      )}

      <div className="footer-note text-[11.5px] text-[var(--nim-text-faint)]">
        For selective Codex loading, set <code>omit_tools_from: [&quot;direct&quot;]</code> on a server in your existing .mcp.json configuration. A supported native client keeps its tools in discovery instead of the initial direct surface. Omit the field or use [] for native defaults. Core tools stay accessible; hiding discovery surfaces is rejected. Use a fresh Codex thread after changing native exposure; existing thread history is unchanged. No app restart is needed.
      </div>
    </div>
  );
}
