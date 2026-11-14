import React, { useEffect, useState } from 'react';
import type { CodexContextInspection } from '@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection';

interface Inspection {
  preparedRequest: CodexContextInspection | null;
  unavailable: string;
}

/** Local byte measurements are deliberately separate from the native token meter. */
export function ContextInspectionDetails({ sessionId }: { sessionId: string }) {
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    (window as any).electronAPI.invoke('mcp-config:get-context-inspection', sessionId)
      .then((value: Inspection) => { if (!cancelled) setInspection(value); })
      .catch(() => { if (!cancelled) setError('Context inspection is unavailable. Provider-reported usage above is independent.'); });
    return () => { cancelled = true; };
  }, [sessionId]);
  return <details className="context-inspection mt-2 text-[11px] whitespace-normal">
    <summary className="cursor-pointer text-[var(--nim-primary)]">Inspect prepared context</summary>
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
  </details>;
}
