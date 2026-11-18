import React from 'react';
import type { CodexRecordedStartup } from '@nimbalyst/runtime/ai/server/providers/codex/codexRecordedStartup';

export interface RecordedStartup {
  report: CodexRecordedStartup | null;
  status: string;
}

/** Native Codex rollout records: messages are listed apart from audit snapshots, which never add to message totals. */
export function RecordedStartupDetails({ recorded }: { recorded: RecordedStartup }) {
  const report = recorded.report;
  const definitions = report?.toolRecords.reduce((sum, block) => sum + block.definitions, 0) ?? 0;
  return <details className="context-recorded-startup mt-3">
    <summary className="cursor-pointer">Recorded native startup: messages and audit snapshots</summary>
    <p className="mt-2">{recorded.status}</p>
    {report && <>
      <p className="mt-2">
        {report.session.role === 'automatic-approval-reviewer' ? 'Automatic approval reviewer' : 'Agent'} · {report.session.model ?? 'model unavailable'} · Codex {report.session.runtimeVersion ?? 'version unavailable'}
      </p>
      <p className="mt-2 font-medium">Recorded messages</p>
      <p>
        {report.messages.length} records · {report.recordedMessageBytes.toLocaleString()} UTF-8 text bytes · {report.boundaryLine ? `through the opening input at log line ${report.boundaryLine}` : 'opening input not found; the capture may be incomplete'}.
        Roles and kinds are transport labels, not proof of authorship.
      </p>
      <ul className="mt-1 space-y-1">{report.messages.map(message => <li key={message.line}>
        <details className="context-recorded-message">
          <summary className="cursor-pointer break-all">Line {message.line}: {message.role} · {message.bytes.toLocaleString()} bytes · {message.kinds.join(', ') || 'kinds unavailable'}</summary>
          <pre className="select-text whitespace-pre-wrap break-words mt-1">{message.text}</pre>
          {message.textTruncated && <p className="text-[var(--nim-text-muted)]">Showing the first 64 KB; the byte count covers the full record.</p>}
        </details>
      </li>)}</ul>
      <p className="mt-2 font-medium">Audit snapshots, excluded from message totals</p>
      {report.snapshots.length ? <ul className="mt-1 space-y-1">{report.snapshots.map(snapshot => <li key={snapshot.line}>
        Line {snapshot.line}: {snapshot.name} · {snapshot.bytes.toLocaleString()} bytes · {snapshot.sameTextAsMessageLine
          ? `same text as the message at line ${snapshot.sameTextAsMessageLine}; one instruction body, not a second copy`
          : 'settings or state record, not a message'}
      </li>)}</ul> : <p>No audit snapshots recorded before the opening input.</p>}
      <p className="mt-2">
        Tool definitions: {report.toolRecords.length} recorded blocks, {definitions} definitions, {report.toolRecords.reduce((sum, block) => sum + block.bytes, 0).toLocaleString()} JSON bytes. Bytes are not tokens.
      </p>
      <p className="mt-2">{report.repeatedMessages.length
        ? `Identical records with matching role and kinds at lines ${report.repeatedMessages.map(group => group.lines.join(', ')).join('; ')}. Repetition in a log does not by itself prove duplicate delivery.`
        : 'No repeated message records in the startup prefix.'}</p>
      <p className="mt-2 text-[var(--nim-text-muted)]">The log records what Codex saved, not the complete request sent to the model. Native encoding, hidden provider additions and token allocation are unavailable.</p>
    </>}
  </details>;
}
