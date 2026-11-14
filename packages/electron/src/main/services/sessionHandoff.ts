import { createHash } from 'node:crypto';

export interface HandoffRequest { id: string; text: string; author: string }
export interface HandoffBrief {
  sourceDigest: string;
  decisions: string[];
  ownership: string[];
  pendingInstructions: string[];
  validationEvidence: string[];
  requests: Array<{ id: string; status: string; reason: string }>;
}
export interface HandoffSnapshot {
  sourceSessionId: string;
  digest: string;
  requests: HandoffRequest[];
  queued: unknown[];
}
export interface RetainedHandoffState {
  id: string;
  sourceSessionId: string;
  evidencePath: string;
  requests: HandoffRequest[];
}

function metadataObject(value: unknown): Record<string, any> {
  if (typeof value === 'string') {
    try { return metadataObject(JSON.parse(value)); } catch { return {}; }
  }
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function provenances(meta: Record<string, any>): Record<string, any>[] {
  if (Array.isArray(meta.coalescedPromptProvenance) && meta.coalescedPromptProvenance.length) return meta.coalescedPromptProvenance.map(metadataObject);
  if (Array.isArray(meta.coalescedPrompts) && meta.coalescedPrompts.length) return meta.coalescedPrompts.map((p: any) => metadataObject(p.promptProvenance));
  return [metadataObject(meta.promptProvenance)];
}
function needsReview(meta: Record<string, any>): boolean {
  return provenances(meta).some(p => (p.actor !== 'agent' && p.actor !== 'system') || !['report', 'status'].includes(p.messageKind));
}
function author(meta: Record<string, any>): string {
  const labels = new Set(provenances(meta).map(p => p.actor ?? 'unknown'));
  return labels.size === 1 ? [...labels][0] : 'mixed (see source provenance)';
}

/** Unknown provenance remains reviewable. Never infer a machine author from prompt wording. */
export function buildHandoffSnapshot(
  sourceSessionId: string,
  rows: Array<{ id: string | number; searchable_text: string | null; metadata: unknown }>,
  queued: unknown[],
  inherited?: RetainedHandoffState,
): HandoffSnapshot {
  // Only explicitly tagged machine reports/status skip accounting. A
  // coalesced batch is reviewed if ANY member can carry an active request.
  const requests: HandoffRequest[] = [];
  let unfolded = false;
  for (const row of rows) {
    const meta = metadataObject(row.metadata);
    const verifiedHandoff = inherited && provenances(meta).every(p => p.actor === 'agent'
      && p.origin === 'session-orchestration' && p.originSessionId === inherited.sourceSessionId
      && p.originMessageId === inherited.id);
    if (verifiedHandoff) {
      if (!unfolded) requests.push(...inherited.requests);
      unfolded = true;
    } else if (needsReview(meta)) {
      requests.push({ id: String(row.id), text: row.searchable_text ?? '', author: author(meta) });
    }
  }
  for (const value of queued) {
    const entry = metadataObject(value);
    const context = metadataObject(entry.document_context);
    if (entry.status === 'pending' && needsReview(context)) {
      requests.push({ id: `queue:${entry.id}`, text: String(entry.prompt ?? ''), author: author(context) });
    }
  }
  const digest = createHash('sha256').update(JSON.stringify({ sourceSessionId, requests, queued })).digest('hex');
  return { sourceSessionId, digest, requests, queued };
}

/** Carry flat active state, not the previous rendered prompt. Stable ids survive handoff chains. */
export function retainHandoffState(snapshot: HandoffSnapshot, brief: HandoffBrief, id: string, evidencePath: string): RetainedHandoffState {
  const pendingIds = new Set(brief.requests.filter(r => r.status === 'pending').map(r => r.id));
  const requests = snapshot.requests.filter(r => pendingIds.has(r.id)).map(r => ({
    ...r, id: r.id.startsWith('handoff:') ? r.id : `handoff:${snapshot.sourceSessionId}:${r.id}`,
  }));
  requests.push({ id: `handoff:${id}:context`, author: 'agent', text: [
    ...(['decisions', 'ownership', 'pendingInstructions', 'validationEvidence'] as const).map(key => `${key}: ${brief[key].join('; ') || '(none)'}`),
    `Reviewed evidence: ${evidencePath}`,
  ].join('\n') });
  return { id, sourceSessionId: snapshot.sourceSessionId, evidencePath, requests };
}

/** Account for human requests and potentially active machine instructions before any spawn side effect. */
export function buildHandoffPrompt(snapshot: HandoffSnapshot, brief: HandoffBrief, task: string, evidencePath: string): string {
  if (!brief || brief.sourceDigest !== snapshot.digest) throw new Error('Source requests changed; call prepare_session_handoff and review again.');
  const reviews = brief.requests;
  const ids = new Set(snapshot.requests.map(r => r.id));
  if (!Array.isArray(reviews) || reviews.length !== ids.size || new Set(reviews.map(r => r.id)).size !== ids.size
    || reviews.some(r => !ids.has(r.id))) throw new Error('Review every human request and potentially active machine instruction exactly once; none may be silently omitted.');
  for (const review of reviews) {
    if (!['pending', 'resolved', 'superseded'].includes(review.status) || !review.reason?.trim()) {
      throw new Error('Each request requires pending/resolved/superseded status and a reason (resolution evidence or superseding request).');
    }
    if (review.id.startsWith('queue:') && review.status !== 'pending') throw new Error('Pending queued requests must remain pending; resolve or cancel them at source first.');
  }
  for (const key of ['decisions', 'ownership', 'pendingInstructions', 'validationEvidence'] as const) {
    if (!Array.isArray(brief[key]) || brief[key].some(v => typeof v !== 'string' || !v.trim())) throw new Error(`${key} must be a list of nonempty strings; use [] only when none apply.`);
  }
  if (brief.ownership.length === 0) throw new Error('Name the successor ownership explicitly.');
  const pendingIds = new Set(reviews.filter(r => r.status === 'pending').map(r => r.id));
  const pending = snapshot.requests.filter(r => pendingIds.has(r.id));
  return [
    `Fresh-session handoff from ${snapshot.sourceSessionId}. This is an agent-authored continuation brief, not new human authorization.`,
    task,
    ...(['decisions', 'ownership', 'pendingInstructions', 'validationEvidence'] as const).map(key => `${key}:\n${brief[key].map(v => `- ${v}`).join('\n') || '(none)'}`),
    `Pending source requests (verbatim, authors labeled; still apply):\n${pending.map(r => `[${r.id}; ${r.author}] ${r.text}`).join('\n\n') || '(none)'}`,
    `Source queue entries (not transferred or executed here; full text in evidence):\n${JSON.stringify(snapshot.queued.map(value => { const entry = metadataObject(value); return { id: entry.id, status: entry.status }; }))}`,
    `Full reviewed ledger and source evidence: ${evidencePath}. Original transcript remains in session ${snapshot.sourceSessionId}; do not replay it wholesale.`,
    'Source execution has NOT been stopped or ownership automatically transferred. Coordinate the source before editing shared files. Read all pending instructions in a linked full-output file before acting. Unanswered source questions/approvals must be resolved in the source; a handoff never grants approval.',
  ].join('\n\n');
}

export const HANDOFF_BRIEF_SCHEMA = {
  type: 'object',
  description: 'Reviewed fresh-session continuation. First call prepare_session_handoff. Account for every human request and potentially active machine instruction; preserve decisions, ownership, constraints and evidence. No transcript replay.',
  properties: {
    sourceDigest: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    ownership: { type: 'array', items: { type: 'string' }, minItems: 1 },
    pendingInstructions: { type: 'array', items: { type: 'string' } },
    validationEvidence: { type: 'array', items: { type: 'string' } },
    requests: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'resolved', 'superseded'] }, reason: { type: 'string' },
    }, required: ['id', 'status', 'reason'] } },
  },
  required: ['sourceDigest', 'decisions', 'ownership', 'pendingInstructions', 'validationEvidence', 'requests'],
};
