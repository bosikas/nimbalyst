import React, { useEffect, useState } from 'react';
import type { CodexContextEvidence } from '@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection';
import type { PreparedContextRequest } from '@nimbalyst/runtime/ai/server/providers/preparedContextInspection';
import { RecordedStartupDetails, type RecordedStartup } from './RecordedStartupDetails';
import { StartupSelectionDetails, type StartupInstructionSelection, type StartupSelection } from './StartupSelectionDetails';

interface Inspection {
  preparedRequest?: PreparedContextRequest | null;
  preparedGuidance?: string;
  selection?: StartupSelection;
  instructionSelection?: StartupInstructionSelection | null;
  unavailable?: string;
  vibe?: { groups: Array<{ name: string; characters: number }>; instructions?: string; acceptedModel?: string | null };
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
      .catch(() => { if (!cancelled) setError('Could not load context evidence.'); });
    return () => { cancelled = true; };
  }, [sessionId, revision]);
  return <div className="context-inspection whitespace-normal">
    <button type="button" onClick={() => setRevision(value => value + 1)} className="text-[var(--nim-link)] hover:underline">Refresh evidence</button>
    {error && <p role="status">{error}</p>}
    {!inspection && !error && <p role="status">Loading measurements…</p>}
    {inspection && <StartupSelectionDetails selection={inspection.selection} instructions={inspection.instructionSelection} />}
    {inspection?.vibe && <p className="mt-2">Last model accepted by Vibe ACP: {inspection.vibe.acceptedModel ?? 'Unavailable for this session'} · Accepted thinking effort: unavailable.</p>}
    {inspection?.preparedRequest && <>
      <p className="mt-2">Last prepared request: {new Date(inspection.preparedRequest.measuredAt).toLocaleString()}</p>
      <p className="text-[var(--nim-text-muted)]">{inspection.preparedRequest.scope}</p>
      <dl>{inspection.preparedRequest.categories.map(category => <div key={category.name} className="mt-2">
        <dt className="font-medium">{category.name}: {category.bytes.toLocaleString()} bytes</dt>
        <dd className="text-[var(--nim-text-muted)]">{category.reason}</dd>
      </div>)}</dl>
      <p className="mt-2">{inspection.preparedRequest.configuredMcpServers} configured MCP servers; {inspection.preparedRequest.attachments} attachments. Attachment encoding and native tool-schema costs are unavailable.</p>
      <p className="mt-2">{inspection.preparedRequest.nativeContext}</p>
      {(inspection.vibe?.instructions || inspection.preparedGuidance) && <details className="mt-2">
        <summary className="cursor-pointer">{inspection.vibe ? 'Prepared Nimbalyst ACP resource' : 'Prepared Nimbalyst developer instructions'}</summary>
        <pre className="mt-2 whitespace-pre-wrap break-words">{inspection.vibe?.instructions ?? inspection.preparedGuidance}</pre>
      </details>}
    </>}
    {inspection?.unavailable && !inspection.preparedRequest && <p className="mt-2">{inspection.unavailable}</p>}
    {inspection?.recordedStartup && <RecordedStartupDetails recorded={inspection.recordedStartup} />}
    {inspection && !inspection.recordedStartup && <p className="mt-2">Native startup text is available in the local desktop inspector when provider records exist.</p>}
    {!!inspection?.vibe?.groups.length && <details className="mt-3">
      <summary className="cursor-pointer">Vibe’s recorded input size</summary>
      <dl className="mt-2">
        {inspection.vibe.groups.map(({ name, characters }) => <div key={name} className="flex justify-between gap-4">
          <dt>{name}</dt><dd>{characters.toLocaleString()} characters</dd>
        </div>)}
      </dl>
    </details>}
    {inspection && <details className="context-tool-visibility mt-3">
      <summary className="cursor-pointer">{inspection.vibe ? 'Configured tools and discovery policy' : 'Tools: configured, deferred & observed'}</summary>
      <p className="mt-2">Configuration shows availability and discovery policy. {inspection.nativeEvidence && 'Observed calls show which tools were used. '}Native loaded schemas remain unknown.</p>
      <ul className="mt-2 space-y-1">{inspection.toolDefinitions?.groups.map(group => <li key={group.configKey}>
        {group.displayName}: {group.enabled ? `configured ${group.loadPolicy}` : 'disabled'} · {group.toolCount} definitions
      </li>)}</ul>
      {inspection.nativeEvidence && <>
        <p className="mt-2 font-medium">Observed MCP tools in this app process</p>
        {inspection.nativeEvidence.observedTools.length ? <ul>{inspection.nativeEvidence.observedTools.map(tool => <li key={`${tool.server}/${tool.tool}`} className="break-all">{tool.server} / {tool.tool} · {tool.calls} calls</li>)}</ul> : <p>No calls observed in this app process.</p>}
        {!!inspection.nativeEvidence.omittedToolCalls && <p>Additional observed calls beyond the 200-name diagnostic limit: {inspection.nativeEvidence.omittedToolCalls}. Full events remain in the transcript.</p>}
      </>}
    </details>}
    {inspection?.nativeEvidence && <details className="context-compaction-comparisons mt-3">
      <summary className="cursor-pointer">Compaction comparisons</summary>
      <p className="mt-2">Last observed provider-reported context tokens before a native compaction and the first usage sample after completion. Later work can affect that sample; differences are not isolated compaction savings. Only the latest 20 observed compactions in this process are shown. Native before/after text is unavailable; the canonical transcript is unchanged.</p>
      {inspection.nativeEvidence?.compactions.length ? <ul className="mt-2 space-y-2">{inspection.nativeEvidence.compactions.map(entry => <li key={entry.id}>
        <time>{new Date(entry.startedAt).toLocaleString()}</time>: {entry.beforeTokens?.toLocaleString() ?? 'Before unavailable'} → {entry.afterTokens?.toLocaleString() ?? (entry.completedAt ? 'Awaiting usage' : 'In progress')}
        {entry.beforeTokens !== null && entry.afterTokens !== null && <span> ({(entry.afterTokens - entry.beforeTokens).toLocaleString()} tokens)</span>}
      </li>)}</ul> : <p className="mt-2">No native compaction observed in this app process. Historical compaction contents cannot be reconstructed from prepared-request bytes.</p>}
    </details>}
  </div>;
}
