import React, { useEffect, useState } from 'react';
import type { CodexContextInspection, CodexContextEvidence } from '@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection';
import { RecordedStartupDetails, type RecordedStartup } from './RecordedStartupDetails';

interface Inspection {
  preparedRequest?: CodexContextInspection | null;
  unavailable?: string;
  vibe?: { groups: Array<{ name: string; characters: number }>; instructions?: string };
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
    window.electronAPI.invoke('mcp-config:get-context-inspection', sessionId)
      .then((value: Inspection) => { if (!cancelled) setInspection(value); })
      .catch(() => { if (!cancelled) setError('Could not load Codex context evidence.'); });
    return () => { cancelled = true; };
  }, [sessionId, revision]);
  return <div className="context-inspection whitespace-normal">
    <button type="button" onClick={() => setRevision(value => value + 1)} className="text-[var(--nim-link)] hover:underline">Refresh evidence</button>
    {error && <p role="status">{error}</p>}
    {!inspection && !error && <p role="status">Loading measurements…</p>}
    {inspection?.preparedRequest && <>
      <p className="mt-2">Last prepared request: {new Date(inspection.preparedRequest.measuredAt).toLocaleString()}</p>
      <p className="text-[var(--nim-text-muted)]">{inspection.preparedRequest.scope}</p>
      <dl>{inspection.preparedRequest.categories.map(category => <div key={category.name} className="mt-2">
        <dt className="font-medium">{category.name}: {category.bytes.toLocaleString()} bytes</dt>
        <dd className="text-[var(--nim-text-muted)]">{category.reason}</dd>
      </div>)}</dl>
      <p className="mt-2">{inspection.preparedRequest.configuredMcpServers} configured MCP servers; {inspection.preparedRequest.attachments} attachments. Attachment encoding and native tool-schema costs are unavailable.</p>
      <p className="mt-2">{inspection.preparedRequest.nativeContext}</p>
    </>}
    {inspection?.unavailable && !inspection.preparedRequest && <p className="mt-2">{inspection.unavailable}</p>}
    {inspection?.vibe && <section className="mt-3">
      <h3 className="font-semibold">Recorded input size</h3>
      {inspection.vibe.groups.length > 0
        ? <dl className="mt-2">
          {inspection.vibe.groups.map(({ name, characters }) => <div key={name} className="flex justify-between gap-4">
            <dt>{name}</dt><dd>{characters.toLocaleString()} characters</dd>
          </div>)}
        </dl>
        : <p className="mt-2">Vibe has no saved context breakdown for this session.</p>}
      <h3 className="mt-4 font-semibold">Nimbalyst prompt instructions</h3>
      {inspection.vibe.instructions
        ? <details className="mt-2">
          <summary>View instructions prepared for the latest prompt</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words">{inspection.vibe.instructions}</pre>
        </details>
        : <p className="mt-2">Available for prompts prepared since the app started.</p>}
    </section>}
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
  </div>;
}
