import React, { useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { createWorkAttentionCountAtom } from './sessionTodayActivity';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { SessionPolicyEditor } from './SessionPolicyControls';

export function SessionWorkAttentionIndicator({ sessionIds, descendantsOnly = false }: { sessionIds: readonly string[]; descendantsOnly?: boolean }) {
  const key = JSON.stringify(sessionIds);
  const count = useAtomValue(useMemo(() => createWorkAttentionCountAtom(JSON.parse(key), descendantsOnly), [key, descendantsOnly]));
  if (!count) return null;
  const label = `${count} ${count === 1 ? 'chat needs' : 'chats need'} your attention`;
  return <span className="session-work-attention" aria-label={label} title={label} />;
}

export function useSessionWorkSummary(sessionId: string) {
  return useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.workSummary), [sessionId]));
}

const labels = { next: 'Next', blocked: 'Blocked', review: 'Review', none: '', unknown: 'To review' };

export function SessionWorkCaption({ sessionId }: { sessionId: string }) {
  const summary = useSessionWorkSummary(sessionId);
  const appearance = useAtomValue(settingAtom('ui.sessionListAppearance'));
  if (!appearance.showSummary && !appearance.showRemaining) return null;
  if (!summary?.scope) return summary?.state === 'updating'
    ? <div className="session-work-caption"><span className="session-work-freshness">Summarizing session scope…</span></div> : null;
  const stale = summary.state !== 'ready' || summary.coverage !== 'complete';
  return <div className={`session-work-caption ${stale ? 'is-stale' : ''}`}>
    {appearance.showSummary && <div className="session-work-scope" title={summary.scope}>{summary.scope}</div>}
    {appearance.showRemaining && summary.attention !== 'none' && <div className={`session-work-remaining attention-${summary.attention}`} title={summary.remaining}>
      <span className="session-work-label">{labels[summary.attention]}</span><span>{summary.remaining || 'Remaining work needs review.'}</span>
    </div>}
    {stale && <span className="session-work-freshness" title={summary.error || (summary.coverage === 'partial' ? 'Some earlier evidence needs review. The transcript is preserved.' : 'Showing the previous summary while this update is pending.')}>
      {summary.state === 'updating' ? 'Updating…' : summary.coverage === 'partial' ? 'Partial history' : 'Update pending'}
    </span>}
  </div>;
}

/** Full captions, provenance and retry live on hover/focus, not in the row. */
export function SessionWorkSummaryDetails({ sessionId, workspacePath }: { sessionId: string; workspacePath: string }) {
  const summary = useSessionWorkSummary(sessionId);
  const summaryEnabled = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.generateSummary !== false), [sessionId]));
  const [request, setRequest] = useState<'idle' | 'queued' | 'failed'>('idle');
  const [evidenceError, setEvidenceError] = useState(false);
  useEffect(() => { if (summary?.state !== 'updating') setRequest('idle'); }, [summary?.updatedAt, summary?.state, summary?.error]);
  return <div className="session-work-details">
    <p className="session-work-details-label">Session scope <span>AI summary</span></p>
    <p>{summary?.scope || 'No session summary yet.'}</p>
    {summary?.attention === 'none' ? <p>No remaining work reported.</p> : <p><strong>{labels[summary?.attention ?? 'unknown']}:</strong> {summary?.remaining || 'Remaining work has not been assessed.'}</p>}
    {summary?.areas.length ? <p className="session-work-areas">{summary.areas.join(' · ')}</p> : null}
    {summary?.updatedAt ? <p className="session-work-provenance">Updated {new Date(summary.updatedAt).toLocaleString()} · through message {summary.throughMessageId}</p> : null}
    {summary?.tokenUsage ? <p className="session-work-provenance">Last summary native usage: {summary.tokenUsage.inputTokens.toLocaleString()} input{summary.tokenUsage.cachedInputTokens !== undefined ? ` (${summary.tokenUsage.cachedInputTokens.toLocaleString()} cached)` : ''} · {summary.tokenUsage.outputTokens.toLocaleString()} output tokens</p> : summary?.updatedAt ? <p className="session-work-provenance">Token usage was not recorded for this summary.</p> : null}
    {summary?.coverage === 'partial' && <p>Partial evidence; review the transcript before assuming completion.</p>}
    {summary?.error && <p role="status">{summary.error}</p>}
    {summary?.evidencePath && <button type="button" className="session-work-refresh" title="Open the source checkpoint and links to earlier summaries" onClick={async event => {
      event.stopPropagation();
      try { await window.electronAPI.invoke('workspace:open-file', { workspacePath, filePath: summary.evidencePath }); setEvidenceError(false); }
      catch { setEvidenceError(true); }
    }}>View evidence</button>}
    {evidenceError && <p role="status">Could not open the evidence file.</p>}
    {!summaryEnabled && <p className="session-work-provenance">Summary generation is disabled for this session. Existing evidence is retained.</p>}
    <button type="button" className="session-work-refresh" disabled={!summaryEnabled || !workspacePath || request === 'queued'} onClick={async event => {
      event.stopPropagation();
      try { await window.electronAPI.invoke('sessions:refresh-work-summary', sessionId, workspacePath); setRequest('queued'); }
      catch { setRequest('failed'); }
    }}>{request === 'queued' ? 'Update queued' : summary?.state === 'updating' ? 'Refresh summary' : 'Update summary'}</button>
    {request === 'failed' && <p role="status">Could not queue an update. Try again.</p>}
    <SessionPolicyEditor sessionId={sessionId} />
  </div>;
}
