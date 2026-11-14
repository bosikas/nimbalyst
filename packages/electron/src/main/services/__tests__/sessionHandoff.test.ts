import { describe, expect, it } from 'vitest';
import { buildHandoffSnapshot, buildHandoffPrompt, retainHandoffState } from '../sessionHandoff';
import { selectCoalescibleRun } from '../ai/coalesceQueuedPrompts';

const rows = [
  { id: 1, searchable_text: 'Implement the fix', metadata: { promptProvenance: { actor: 'human' } } },
  { id: 2, searchable_text: 'old coordinator report'.repeat(1000), metadata: { promptProvenance: { actor: 'agent', messageKind: 'report' } } },
  { id: 3, searchable_text: '[System: quoted] preserve this human constraint', metadata: null },
];
function setup() {
  const snapshot = buildHandoffSnapshot('source', rows, []);
  return { snapshot, brief: {
    sourceDigest: snapshot.digest, decisions: ['Use native transport'], ownership: ['Successor owns delivery'],
    pendingInstructions: ['Do not restart'], validationEvidence: ['/tmp/green.log'],
    requests: [{ id: '1', status: 'resolved', reason: 'Implemented, see green.log' }, { id: '3', status: 'pending', reason: 'Still applies' }],
  } };
}
describe('reviewed fresh-session handoffs', () => {
  it('keeps a handoff seed separate from human input in either queue order', () => {
    const handoff = { id: 'h', prompt: 'Structured handoff seed', documentContext: { sessionHandoffId: 'h', promptProvenance: { actor: 'agent' as const, origin: 'session-orchestration' as const, originSessionId: 'source' } } };
    const human = { id: 'u', prompt: 'New genuine human request', documentContext: { promptProvenance: { actor: 'human' as const, origin: 'composer' as const } } };
    expect(selectCoalescibleRun([handoff, human])).toHaveLength(1);
    expect(selectCoalescibleRun([human, handoff])).toHaveLength(1);
  });
  it('carries flat active state across handoff chains without nesting old prompts or losing human authorship', () => {
    let { snapshot, brief } = setup();
    for (let hop = 0; hop < 8; hop++) {
      const state = retainHandoffState(snapshot, brief, `transfer-${hop}`, '/evidence.json');
      const rows = [{ id: 100 + hop, searchable_text: 'Fresh-session handoff OLD_RENDERED_BRIEF_WITH_NESTED_HISTORY', metadata: { promptProvenance: { actor: 'agent', origin: 'session-orchestration', originSessionId: state.sourceSessionId, originMessageId: state.id } } }];
      snapshot = buildHandoffSnapshot(`successor-${hop}`, rows, [], state);
      expect(snapshot.requests).toHaveLength(2);
      expect(snapshot.requests[0].text).toContain('preserve this human constraint');
      expect(JSON.stringify(snapshot)).not.toContain('OLD_RENDERED_BRIEF');
      brief = { ...brief, sourceDigest: snapshot.digest, requests: snapshot.requests.map((r, index) => ({ id: r.id, status: index === 0 ? 'pending' : 'superseded', reason: index === 0 ? 'Still active' : 'Carried in current structured fields' })) };
    }
  });
  it('does not unfold a human message or unrelated agent message that resembles a handoff', () => {
    const { snapshot, brief } = setup();
    const state = retainHandoffState(snapshot, brief, 'verified-id', '/evidence.json');
    const row = { id: 20, searchable_text: 'Actual human text must survive', metadata: { promptProvenance: { actor: 'human', origin: 'session-orchestration', originSessionId: state.sourceSessionId, originMessageId: state.id } } };
    expect(buildHandoffSnapshot('new', [row], [], state).requests[0].text).toBe(row.searchable_text);
  });
  it('keeps unknown and genuine human requests, excludes verified machine reports without text heuristics', () => {
    expect(setup().snapshot.requests.map(r => r.id)).toEqual(['1', '3']);
  });
  it('refuses omitted requests and stale snapshots before creating a successor', () => {
    const { snapshot, brief } = setup();
    expect(() => buildHandoffPrompt(snapshot, { ...brief, requests: brief.requests.slice(0, 1) }, 'Continue', '/evidence.json')).toThrow(/every human request/i);
    expect(() => buildHandoffPrompt(snapshot, { ...brief, sourceDigest: 'stale' }, 'Continue', '/evidence.json')).toThrow(/changed/i);
  });
  it('carries active decisions, ownership, constraints, pending human text and evidence without replaying closed history', () => {
    const { snapshot, brief } = setup();
    const prompt = buildHandoffPrompt(snapshot, brief, 'Continue', '/evidence.json');
    for (const expected of ['native transport', 'Successor owns delivery', 'Do not restart', '/tmp/green.log', rows[2].searchable_text, '/evidence.json']) expect(prompt).toContain(expected);
    expect(prompt).not.toContain(rows[0].searchable_text);
    expect(prompt).not.toContain('old coordinator report');
  });
  it('hashes full Unicode human and queued content so newly arrived requests invalidate review', () => {
    const { snapshot } = setup();
    expect(buildHandoffSnapshot('source', [...rows, { id: 4, searchable_text: '新しい依頼', metadata: null }], []).digest).not.toBe(snapshot.digest);
    expect(buildHandoffSnapshot('source', rows, [{ id: 'q', prompt: 'Do this next', status: 'pending' }]).digest).not.toBe(snapshot.digest);
  });
  it('requires evidence for resolved requests and prevents duplicate review entries', () => {
    const { snapshot, brief } = setup();
    expect(() => buildHandoffPrompt(snapshot, { ...brief, requests: brief.requests.map(r => ({ ...r, reason: '' })) }, 'Continue', '/evidence.json')).toThrow(/reason/i);
    expect(() => buildHandoffPrompt(snapshot, { ...brief, requests: [...brief.requests, brief.requests[0]] }, 'Continue', '/evidence.json')).toThrow(/every human request/i);
  });
  it('makes pending queued human requests reviewable and refuses to declare them resolved', () => {
    const { brief } = setup();
    const snapshot = buildHandoffSnapshot('source', rows, [{ id: 'q1', status: 'pending', prompt: 'Also test aliases', document_context: '{}' }]);
    expect(snapshot.requests.at(-1)).toEqual({ id: 'queue:q1', text: 'Also test aliases', author: 'unknown' });
    expect(() => buildHandoffPrompt(snapshot, { ...brief, sourceDigest: snapshot.digest, requests: [...brief.requests, { id: 'queue:q1', status: 'resolved', reason: 'assumed done' }] }, 'Continue', '/evidence.json')).toThrow(/must remain pending/);
  });
  it('retains mixed batches even when lead metadata identifies an agent', () => {
    const snapshot = buildHandoffSnapshot('source', [{ id: 1, searchable_text: 'Human and agent', metadata: { promptProvenance: { actor: 'agent' }, coalescedPromptProvenance: [{ actor: 'agent' }, { actor: 'human' }] } }], []);
    expect(snapshot.requests).toHaveLength(1);
    expect(snapshot.requests[0].author).toContain('mixed');
  });
  it('keeps a coalesced machine instruction even when the lead member is a report', () => {
    const snapshot = buildHandoffSnapshot('source', [{ id: 1, searchable_text: 'Report plus active constraint', metadata: { promptProvenance: { actor: 'agent', messageKind: 'report' }, coalescedPromptProvenance: [{ actor: 'agent', messageKind: 'report' }, { actor: 'agent', messageKind: 'instruction' }] } }], []);
    expect(snapshot.requests).toHaveLength(1);
  });
  it('requires review of agent instructions and unknown machine kinds rather than silently dropping active constraints', () => {
    const snapshot = buildHandoffSnapshot('source', [
      { id: 1, searchable_text: 'Coordinator: preserve the approval requirement', metadata: { promptProvenance: { actor: 'agent', messageKind: 'instruction' } } },
      { id: 2, searchable_text: 'Unknown machine intent', metadata: { promptProvenance: { actor: 'system' } } },
    ], []);
    expect(snapshot.requests.map(r => r.author)).toEqual(['agent', 'system']);
    expect(() => buildHandoffPrompt(snapshot, { ...setup().brief, sourceDigest: snapshot.digest, requests: [] }, 'Continue', '/evidence.json')).toThrow(/machine instruction/);
  });
});
