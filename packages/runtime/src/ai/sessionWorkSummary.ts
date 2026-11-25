import { instructionTemplate } from './instructionTemplates';

/** Small, derived sidebar state. The canonical transcript remains authoritative. */
export const SESSION_WORK_SUMMARY_GUIDANCE = instructionTemplate('session-metadata.work-summary');

export const SESSION_OUTCOME_LIMIT = 170;
export const SESSION_WRITE_UP_LIMIT = 8;
export const SESSION_WRITE_UP_TEXT_LIMIT = 500;
export const SESSION_WRITE_UP_KINDS = ['outcome', 'finding', 'decision'] as const;

export interface SessionWriteUpPoint {
  kind: typeof SESSION_WRITE_UP_KINDS[number];
  text: string;
  messageId?: number;
}

export interface SessionNarrative {
  outcome?: string;
  writeUp?: SessionWriteUpPoint[];
}

/** A malformed optional write-up must not discard a usable work summary. */
export function readSessionNarrative(value: unknown): SessionNarrative {
  if (!value || typeof value !== 'object') return {};
  const summary = value as SessionNarrative;
  const outcome = typeof summary.outcome === 'string' && summary.outcome.length <= SESSION_OUTCOME_LIMIT
    ? summary.outcome.replace(/\s+/g, ' ').trim() : '';
  const writeUp = Array.isArray(summary.writeUp) && summary.writeUp.length <= SESSION_WRITE_UP_LIMIT ? summary.writeUp.flatMap((point) => {
    if (!point || !SESSION_WRITE_UP_KINDS.includes(point.kind) || typeof point.text !== 'string'
      || !point.text.trim() || point.text.length > SESSION_WRITE_UP_TEXT_LIMIT) return [];
    const messageId = Number.isSafeInteger(point.messageId) && Number(point.messageId) > 0 ? point.messageId : undefined;
    return [{ kind: point.kind, text: point.text.trim(), ...(messageId ? { messageId } : {}) }];
  }) : undefined;
  const usableWriteUp = writeUp && (writeUp.length > 0 || summary.writeUp?.length === 0);
  return { ...(outcome ? { outcome } : {}), ...(usableWriteUp ? { writeUp } : {}) };
}

export interface SessionWorkSummary extends SessionNarrative {
  scope: string;
  remaining: string;
  attention: 'next' | 'blocked' | 'review' | 'none' | 'unknown';
  areas: string[];
  updatedAt: number;
  throughMessageId: number;
  state: 'ready' | 'updating' | 'stale' | 'unavailable';
  coverage: 'complete' | 'partial';
  evidencePath?: string;
  source?: 'agent' | 'background';
  error?: string;
  tokenUsage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number };
}

export function readSessionWorkSummary(value: unknown): SessionWorkSummary | undefined {
  if (typeof value === 'string') {
    try { return readSessionWorkSummary(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  const s = value as SessionWorkSummary;
  if (s.source !== undefined && s.source !== 'agent' && s.source !== 'background') return undefined;
  if (s.tokenUsage && (!Number.isSafeInteger(s.tokenUsage.inputTokens) || s.tokenUsage.inputTokens < 0 || !Number.isSafeInteger(s.tokenUsage.outputTokens) || s.tokenUsage.outputTokens < 0
    || (s.tokenUsage.cachedInputTokens !== undefined && (!Number.isSafeInteger(s.tokenUsage.cachedInputTokens) || s.tokenUsage.cachedInputTokens < 0)))) return undefined;
  if (typeof s.scope !== 'string' || s.scope.length > 220 || typeof s.remaining !== 'string' || s.remaining.length > 280
    || !['next', 'blocked', 'review', 'none', 'unknown'].includes(s.attention)
    || !['ready', 'updating', 'stale', 'unavailable'].includes(s.state)
    || !['complete', 'partial'].includes(s.coverage)
    || !Number.isFinite(s.updatedAt) || s.updatedAt < 0 || !Number.isSafeInteger(s.throughMessageId) || s.throughMessageId < 0
    || (s.evidencePath !== undefined && (typeof s.evidencePath !== 'string' || s.evidencePath.length > 2000))
    || (s.error !== undefined && (typeof s.error !== 'string' || s.error.length > 240))
    || !Array.isArray(s.areas) || s.areas.length > 6 || s.areas.some(a => typeof a !== 'string' || a.length > 40)) return undefined;
  const { outcome, writeUp, ...summary } = s;
  return { ...summary, ...readSessionNarrative({ outcome, writeUp }) };
}

export type WorkSummaryFilter = 'all' | 'remaining' | 'blocked' | 'review' | `area:${string}`;
export function matchesWorkSummaryFilter(summary: SessionWorkSummary | undefined, filter: WorkSummaryFilter): boolean {
  if (filter === 'all') return true;
  if (!summary) return false;
  if (filter.startsWith('area:')) return summary.areas.some(area => area.toLocaleLowerCase() === filter.slice(5).toLocaleLowerCase());
  if (filter === 'remaining') return summary.attention !== 'none' || (summary.source !== 'agent' && summary.coverage !== 'complete') || summary.state !== 'ready';
  return summary.attention === filter;
}

export function matchesSessionWorkSearch(session: { title?: string; workSummary?: SessionWorkSummary }, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [session.title, session.workSummary?.scope, session.workSummary?.remaining, ...(session.workSummary?.areas ?? [])].join(' ').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}
