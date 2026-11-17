import type { SessionWorkSummary } from '@nimbalyst/runtime/ai/sessionWorkSummary';

export type SessionSummaryDraft = Pick<SessionWorkSummary, 'scope' | 'remaining' | 'attention' | 'areas'>;

export function readSessionSummaryDraft(value: unknown): SessionSummaryDraft {
  const draft = value as SessionSummaryDraft | undefined;
  if (!draft || typeof draft.scope !== 'string' || !draft.scope.trim() || draft.scope.length > 220
    || typeof draft.remaining !== 'string' || draft.remaining.length > 280
    || !['next', 'blocked', 'review', 'none', 'unknown'].includes(draft.attention)
    || !Array.isArray(draft.areas) || draft.areas.length > 6
    || draft.areas.some(area => typeof area !== 'string' || !area.trim() || area.length > 40)
    || (draft.attention === 'none') !== !draft.remaining.trim()) {
    throw new Error('Invalid summary: provide a whole-session scope, areas, and remaining work consistent with attention.');
  }
  return { scope: draft.scope.trim(), remaining: draft.remaining.trim(), attention: draft.attention, areas: [...new Set(draft.areas.map(area => area.trim()))] };
}

/** Host identities, never agent-supplied IDs, associate submissions with turns. */
export class SessionSummaryDelivery {
  private turns = new Map<string, { identity: object; revision: object; submitted: boolean }>();
  private locks = new Map<string, Promise<unknown>>();

  started(id: string, identity: object): void {
    if (this.turns.get(id)?.identity === identity) return;
    this.turns.set(id, { identity, revision: {}, submitted: false });
  }
  revision(id: string): object | undefined { return this.turns.get(id)?.revision; }
  submitted(id: string): boolean { return this.turns.get(id)?.submitted === true; }
  accept(id: string, expected: object): void {
    const turn = this.turns.get(id);
    if (!turn || turn.revision !== expected) throw new Error('The session moved to another turn.');
    turn.submitted = true;
    turn.revision = {};
  }
  async write<T>(id: string, run: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior.catch(() => undefined).then(run);
    this.locks.set(id, next);
    try { return await next; }
    finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
}
