/** Small, derived sidebar state. The canonical transcript remains authoritative. */
export interface SessionWorkSummary {
  scope: string;
  remaining: string;
  attention: 'next' | 'blocked' | 'review' | 'none' | 'unknown';
  areas: string[];
  updatedAt: number;
  throughMessageId: number;
  state: 'ready' | 'updating' | 'stale' | 'unavailable';
  coverage: 'complete' | 'partial';
  evidencePath?: string;
  error?: string;
  tokenUsage?: { inputTokens: number; cachedInputTokens?: number; outputTokens: number };
}

export function readSessionWorkSummary(value: unknown): SessionWorkSummary | undefined {
  if (typeof value === 'string') {
    try { return readSessionWorkSummary(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  const s = value as SessionWorkSummary;
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
  return s;
}

export type WorkSummaryFilter = 'all' | 'remaining' | 'blocked' | 'review' | `area:${string}`;
export function matchesWorkSummaryFilter(summary: SessionWorkSummary | undefined, filter: WorkSummaryFilter): boolean {
  if (filter === 'all') return true;
  if (!summary) return false;
  if (filter.startsWith('area:')) return summary.areas.some(area => area.toLocaleLowerCase() === filter.slice(5).toLocaleLowerCase());
  if (filter === 'remaining') return summary.attention !== 'none' || summary.coverage !== 'complete' || summary.state !== 'ready';
  return summary.attention === filter;
}

export function matchesSessionWorkSearch(session: { title?: string; workSummary?: SessionWorkSummary }, query: string): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  const text = [session.title, session.workSummary?.scope, session.workSummary?.remaining, ...(session.workSummary?.areas ?? [])].join(' ').toLocaleLowerCase();
  return words.every(word => text.includes(word));
}
