import {
  readSessionNarrative, SESSION_OUTCOME_LIMIT, SESSION_WRITE_UP_KINDS, SESSION_WRITE_UP_LIMIT,
  SESSION_WRITE_UP_TEXT_LIMIT, type SessionWorkSummary,
} from '@nimbalyst/runtime/ai/sessionWorkSummary';

export type SessionSummaryDraft = Pick<SessionWorkSummary, 'scope' | 'remaining' | 'attention' | 'areas' | 'outcome' | 'writeUp'>;

export const summaryNarrativeSchema = {
  outcome: { type: 'string', maxLength: SESSION_OUTCOME_LIMIT, description: 'One plain-language sentence on what changed or was learned. Omit before there is an outcome or when it has not changed. Stick to the change itself. The board reads delivery status separately.' },
  writeUp: {
    type: 'array', maxItems: SESSION_WRITE_UP_LIMIT,
    description: 'An optional fuller account for substantial work. Include outcomes, findings, and decisions with their reasoning. Use own-session source message IDs where known. Supply the whole updated write-up when it changes and omit it for routine updates or simple sessions.',
    items: { type: 'object', additionalProperties: false, required: ['kind', 'text'], properties: {
      kind: { type: 'string', enum: [...SESSION_WRITE_UP_KINDS] },
      text: { type: 'string', maxLength: SESSION_WRITE_UP_TEXT_LIMIT },
      messageId: { type: 'integer', minimum: 1 },
    } },
  },
};

const condition = {
  type: 'object', additionalProperties: false, required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['merge', 'ci', 'review', 'run', 'ticket'] },
    number: { type: 'integer', minimum: 1 }, run: { type: 'integer', minimum: 1 },
    ticket: { type: 'string' }, sha: { type: 'string' },
  },
};
const MAX_WORK_ITEMS = 25;
export const summaryWorkSchema = {
  type: 'array', maxItems: MAX_WORK_ITEMS,
  description: 'Report concrete open actions or handoffs to Work Overview in this same call. Reuse earlier keys or item IDs. Write each independent remainder on its own line and copy a tracked line into summaryLine. Leave other lines in remaining. Omit work on routine turns without tracked changes.',
  items: {
    type: 'object', additionalProperties: false, required: ['action'],
    properties: {
      action: { type: 'string', enum: ['put', 'offer', 'accept', 'withdraw'] },
      id: { type: 'string', description: 'Existing item ID, including for handoff acceptance.' },
      key: { type: 'string', description: 'Stable lowercase slug for a new item.' },
      text: { type: 'string', maxLength: 500 },
      next: { type: 'string', enum: ['session', 'owner', 'external'] },
      summaryLine: { type: 'string', maxLength: 280, description: 'Exact full line from remaining that this item represents.' },
      sessionId: { type: 'string', description: 'Recipient of a handoff offer.' },
      request: { type: 'object', additionalProperties: false, required: ['messageId', 'part'], properties: {
        messageId: { type: 'integer', minimum: 1 }, part: { type: 'integer', minimum: 0 },
      } },
      waitFor: { ...condition, description: 'Exact condition that makes the item ready.' },
      completeWhen: { ...condition, description: 'Exact condition that completes this item.' },
      clearWait: { type: 'boolean' }, clearCompletion: { type: 'boolean' },
    },
  },
};

export function readSummaryWork(value: unknown): unknown[] | undefined {
  const work = (value as { work?: unknown } | null)?.work;
  if (work === undefined) return undefined;
  if (!Array.isArray(work) || work.length > MAX_WORK_ITEMS || JSON.stringify(work).length > 36_000
    || work.some(item => !item || typeof item !== 'object' || !summaryWorkSchema.items.properties.action.enum.includes(item.action))) {
    throw new Error('Invalid structured work. Use at most 25 work item changes.');
  }
  return work;
}

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
  return { scope: draft.scope.trim(), remaining: draft.remaining.trim(), attention: draft.attention,
    areas: [...new Set(draft.areas.map(area => area.trim()))], ...readSessionNarrative(draft) };
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
