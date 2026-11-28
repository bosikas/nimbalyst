import React from 'react';
import type { CodexRecordedMessage, CodexRecordedStartup } from '@nimbalyst/runtime/ai/server/providers/codex/codexRecordedStartup';

export interface RecordedStartup {
  report: CodexRecordedStartup | null;
  status: string;
  conversation?: { messages: CodexRecordedMessage[]; limited: boolean };
}

function RecordedMessages({ messages, label }: { messages: CodexRecordedMessage[]; label: string }) {
  return <ul className="mt-1 space-y-1">{messages.map(message => <li key={message.line}>
    <details className="context-recorded-message">
      <summary className="cursor-pointer break-all">{label} {message.line}: {message.role} · {message.bytes.toLocaleString()} bytes · {message.kinds.join(', ') || 'kinds unavailable'}</summary>
      {message.text && <pre className="select-text whitespace-pre-wrap break-words mt-1">{message.text}</pre>}
      {message.textTruncated && <p className="text-[var(--nim-text-muted)]">{label === 'Line'
        ? 'Showing the first 64 KB; the byte count covers the full record.'
        : 'Text preview truncated. The byte count covers the full record.'}</p>}
    </details>
  </li>)}</ul>;
}

/** Recorded provider messages and audit snapshots. */
export function RecordedStartupDetails({ recorded }: { recorded: RecordedStartup }) {
  const { report, conversation } = recorded;
  const definitions = report?.toolRecords.reduce((sum, block) => sum + block.definitions, 0) ?? 0;
  const vibe = report?.provider === 'mistral-vibe';
  const recordLabel = vibe ? 'Record' : 'Line';
  return <><details open className="context-recorded-startup mt-3">
    <summary className="cursor-pointer">Recorded native startup: messages and audit snapshots</summary>
    <p className="mt-2">{recorded.status}</p>
    {report && <>
      <p className="mt-2">
        {vibe
          ? `Mistral Vibe · ${report.session.model ? `Selected model: ${report.session.model}` : 'CLI model selection'}`
          : `${report.session.role === 'automatic-approval-reviewer' ? 'Automatic approval reviewer' : 'Agent'} · ${report.session.model ?? 'model unavailable'} · Codex ${report.session.runtimeVersion ?? 'version unavailable'}`}
      </p>
      <p className="mt-2 font-medium">Recorded messages</p>
      <p>
        {report.messages.length} records · {report.recordedMessageBytes.toLocaleString()} UTF-8 text bytes · {report.boundaryLine ? `through the opening input at ${vibe ? 'record' : 'log line'} ${report.boundaryLine}` : 'opening input not found; the capture may be incomplete'}.
        Roles and kinds are transport labels, not proof of authorship.
      </p>
      <RecordedMessages messages={report.messages} label={recordLabel} />
      <p className="mt-2 font-medium">Audit snapshots, excluded from message totals</p>
      {report.snapshots.length ? <ul className="mt-1 space-y-1">{report.snapshots.map(snapshot => <li key={snapshot.line}>
        {snapshot.text !== undefined ? <details>
          <summary className="cursor-pointer">{snapshot.name} · {snapshot.bytes.toLocaleString()} bytes</summary>
          <pre className="select-text whitespace-pre-wrap break-words mt-1">{snapshot.text}</pre>
          {snapshot.textTruncated && <p>Showing the first 64 KB of the snapshot.</p>}
        </details> : <>Line {snapshot.line}: {snapshot.name} · {snapshot.bytes.toLocaleString()} bytes · {snapshot.sameTextAsMessageLine
          ? `same text as the message at line ${snapshot.sameTextAsMessageLine}; one instruction body, not a second copy`
          : 'settings or state record, not a message'}</>}
      </li>)}</ul> : <p>No audit snapshots recorded before the opening input.</p>}
      {vibe && report.toolRecords.length === 0 ? <p className="mt-2">Tool schemas are unavailable in the saved Vibe checkpoint.</p> : <p className="mt-2">
        Tool definitions: {report.toolRecords.length} recorded blocks, {definitions} definitions, {report.toolRecords.reduce((sum, block) => sum + block.bytes, 0).toLocaleString()} JSON bytes. Bytes are not tokens.
      </p>}
      <p className="mt-2">{report.repeatedMessages.length
        ? `Identical records with matching role and kinds at lines ${report.repeatedMessages.map(group => group.lines.join(', ')).join('; ')}. Repetition in a log does not by itself prove duplicate delivery.`
        : 'No repeated message records in the startup prefix.'}</p>
      <p className="mt-2 text-[var(--nim-text-muted)]">{vibe
        ? 'These are Vibe’s saved startup records. The provider’s complete model request is unavailable.'
        : 'The log records what Codex saved, not the complete request sent to the model. Native encoding, hidden provider additions and token allocation are unavailable.'}</p>
    </>}
  </details>
    {!!conversation?.messages.length && <details className="context-recorded-conversation mt-3">
      <summary className="cursor-pointer">Retained conversation ({conversation.messages.length.toLocaleString()})</summary>
      {conversation.limited && <p className="mt-2 text-[var(--nim-text-muted)]">Showing the earliest records in the retained checkpoint up to the inspection limit.</p>}
      <RecordedMessages messages={conversation.messages} label="Record" />
    </details>}
  </>;
}
