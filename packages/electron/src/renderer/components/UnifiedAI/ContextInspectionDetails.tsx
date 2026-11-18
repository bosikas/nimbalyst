import React, { useEffect, useState } from 'react';
import type { CodexContextInspection, CodexContextEvidence } from '@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection';
import { RecordedStartupDetails, type RecordedStartup } from './RecordedStartupDetails';

interface Inspection {
  preparedRequest: CodexContextInspection | null;
  unavailable: string;
  nativeEvidence?: CodexContextEvidence;
  recordedStartup?: RecordedStartup;
  toolDefinitions?: { groups: Array<{ configKey: string; displayName: string; enabled: boolean; loadPolicy: string; toolCount: number }> };
}

/** Local byte measurements are deliberately separate from the native token meter. */
export function ContextInspectionDetails({ sessionId }: { sessionId: string }) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setInspection(null);
    setError(null);
    (window as any).electronAPI.invoke('mcp-config:get-context-inspection', sessionId)
      .then((value: Inspection) => { if (!cancelled) setInspection(value); })
      .catch(() => { if (!cancelled) setError('Context inspection is unavailable. Provider-reported usage above is independent.'); });
    return () => { cancelled = true; };
  }, [sessionId, revision]);
  return <details className="context-inspection mt-2 text-[11px] whitespace-normal">
    <summary className="cursor-pointer text-[var(--nim-primary)]">Inspect prepared context</summary>
    <button type="button" onClick={() => setRevision(value => value + 1)} className="mt-2 text-[var(--nim-link)]">Refresh evidence</button>
    <p className="mt-2">Token counts above are provider-reported. The measurements below are local UTF-8 text bytes; they are not token categories or a full native context breakdown.</p>
    {error && <p role="status">{error}</p>}
    {!inspection && !error && <p role="status">Loading measurements…</p>}
    {inspection?.preparedRequest && <>
      <p className="mt-2">Last prepared request: {new Date(inspection.preparedRequest.measuredAt).toLocaleString()}</p>
      <dl>{inspection.preparedRequest.categories.map(category => <div key={category.name} className="mt-2">
        <dt className="font-medium">{category.name}: {category.bytes.toLocaleString()} bytes</dt>
        <dd className="text-[var(--nim-text-muted)]">{category.reason}</dd>
      </div>)}</dl>
      <p className="mt-2">{inspection.preparedRequest.configuredMcpServers} configured MCP servers; {inspection.preparedRequest.attachments} attachments. Attachment encoding and native tool-schema costs are unavailable.</p>
      <p className="mt-2">{inspection.preparedRequest.nativeContext}</p>
    </>}
    {inspection && !inspection.preparedRequest && <p className="mt-2">{inspection.unavailable}</p>}
    {inspection?.recordedStartup && <RecordedStartupDetails recorded={inspection.recordedStartup} />}
    {inspection && <details className="context-tool-visibility mt-3">
      <summary className="cursor-pointer">Tools: configured, deferred &amp; observed</summary>
      <p className="mt-2">Configuration shows availability and discovery policy. Observed calls prove use, not the complete loaded-tool set. Native loaded schemas remain unknown.</p>
      <ul className="mt-2 space-y-1">{inspection.toolDefinitions?.groups.map(group => <li key={group.configKey}>
        {group.displayName}: {group.enabled ? `configured ${group.loadPolicy}` : 'disabled'} · {group.toolCount} definitions
      </li>)}</ul>
      <p className="mt-2 font-medium">Observed MCP tools in this app process</p>
      {inspection.nativeEvidence?.observedTools.length ? <ul>{inspection.nativeEvidence.observedTools.map(tool => <li key={`${tool.server}/${tool.tool}`} className="break-all">{tool.server} / {tool.tool} · {tool.calls} calls</li>)}</ul> : <p>No calls observed here. This does not mean no tools are available or were used before this process started.</p>}
      {!!inspection.nativeEvidence?.omittedToolCalls && <p>Additional observed calls beyond the 200-name diagnostic limit: {inspection.nativeEvidence.omittedToolCalls}. Full events remain in the transcript.</p>}
    </details>}
    {inspection && <details className="context-compaction-comparisons mt-3">
      <summary className="cursor-pointer">Compaction comparisons</summary>
      <p className="mt-2">Last observed provider-reported context tokens before a native compaction and the first usage sample after completion. Later work can affect that sample; differences are not isolated compaction savings. Only the latest 20 observed compactions in this process are shown. Native before/after text is unavailable; the canonical transcript is unchanged.</p>
      {inspection.nativeEvidence?.compactions.length ? <ul className="mt-2 space-y-2">{inspection.nativeEvidence.compactions.map(entry => <li key={entry.id}>
        <time>{new Date(entry.startedAt).toLocaleString()}</time>: {entry.beforeTokens?.toLocaleString() ?? 'Before unavailable'} → {entry.afterTokens?.toLocaleString() ?? (entry.completedAt ? 'Awaiting usage' : 'In progress')}
        {entry.beforeTokens !== null && entry.afterTokens !== null && <span> ({(entry.afterTokens - entry.beforeTokens).toLocaleString()} tokens)</span>}
      </li>)}</ul> : <p className="mt-2">No native compaction observed in this app process. Historical compaction contents cannot be reconstructed from prepared-request bytes.</p>}
    </details>}
  </details>;
}
