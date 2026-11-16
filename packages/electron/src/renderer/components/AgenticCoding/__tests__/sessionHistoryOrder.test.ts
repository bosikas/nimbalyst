// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { createCommittedRankBuilder, createSessionOrder, getLiveSessionOrderTimestamp } from '../sessionHistoryOrder';
import { createStore } from 'jotai';
import { createTodayActivityGroupsAtom, createWorkAttentionCountAtom } from '../sessionTodayActivity';
import { matchesSessionWorkSearch, matchesWorkSummaryFilter, readSessionWorkSummary, type SessionWorkSummary } from '@nimbalyst/runtime/ai/sessionWorkSummary';
import {
  sessionChildrenAtom, sessionHasPendingInteractivePromptAtom, sessionPendingPromptAtom,
  sessionProcessingAtom, sessionRegistryAtom, type SessionMeta,
} from '../../../store/atoms/sessions';

const a = { id: 'a', createdAt: 10, updatedAt: 30 };
const b = { id: 'b', createdAt: 20, updatedAt: 25 };

describe('session history ordering', () => {
  it('uses creation time, message time, or turn boundaries for the selected mode', () => {
    const options = { sortBy: 'updated' as const, mode: 'agent' as const, turnActivity: new Map([['a', 50]]) };
    expect(getLiveSessionOrderTimestamp(a, options)).toBe(50);
    expect(getLiveSessionOrderTimestamp(a, { ...options, mode: 'chat' })).toBe(30);
    expect(getLiveSessionOrderTimestamp(a, { ...options, sortBy: 'created' })).toBe(10);
    expect(getLiveSessionOrderTimestamp({ ...a, updatedAt: 0 }, { ...options, mode: 'chat' })).toBe(10);
  });

  it('holds displayed order while live turns change, then uses rank and creation time to break ties', () => {
    const options = {
      sortBy: 'updated' as const, mode: 'agent' as const,
      workspaceTurnActivity: new Map([['a', 100]]),
      useThrottledTurnOrdering: true,
      displayOrderTimestampMap: new Map([['a', 5], ['b', 5]]),
      displayOrderRankMap: new Map([['a', 1], ['b', 0]]),
    };
    const held = createSessionOrder(options);
    expect([a, b].sort(held.compareSessionOrder)).toEqual([b, a]);
    expect(held.getDisplayedOrderRank('missing')).toBe(Number.MAX_SAFE_INTEGER);
    expect(createSessionOrder({ ...options, useThrottledTurnOrdering: false }).compareSessionOrder(a, b)).toBeLessThan(0);
    expect(createSessionOrder({ ...options, displayOrderRankMap: new Map() }).compareSessionOrder(a, b)).toBeGreaterThan(0);
    expect(held.getDisplayedOrderTimestamp({ ...a, id: 'z' })).toBe(30);
    const tied = createSessionOrder({ ...options, sortBy: 'created', useThrottledTurnOrdering: false, displayOrderRankMap: new Map() });
    expect(tied.compareSessionOrder(a, { ...a, id: 'z' })).toBeLessThan(0);
  });

  it('commits new timestamps while retaining previous tie order and placing new ties deterministically', () => {
    const registry = new Map([['a', a], ['b', b], ['c', { ...b, id: 'c' }]]);
    const build = createCommittedRankBuilder(registry, new Map([['a', 0], ['b', 1]]));
    expect([...build(new Map([['a', 1], ['b', 1], ['c', 2]])).keys()]).toEqual(['c', 'a', 'b']);
    const fresh = createCommittedRankBuilder(registry, new Map());
    expect([...fresh(new Map()).keys()]).toEqual(['b', 'c', 'a']);
  });
});

describe('Today live activity sections', () => {
  const group = { id: 'worktree', sessions: ['root', 'sibling'] };
  const idle = { id: 'idle', sessions: ['idle'] };
  function setup() {
    const store = createStore();
    const rows = [
      { id: 'root', phase: 'complete' }, { id: 'sibling' },
      { id: 'child', parentSessionId: 'root' },
      { id: 'grandchild', parentSessionId: 'child' }, { id: 'idle' },
    ] as SessionMeta[];
    store.set(sessionRegistryAtom, new Map(rows.map(row => [row.id, row])));
    const sections = createTodayActivityGroupsAtom([group, idle], item => item.sessions);
    return { store, sections };
  }

  it('keeps a worktree together when a collapsed nested descendant starts and finishes', () => {
    const { store, sections } = setup();
    expect(store.get(sections).Idle).toEqual([group, idle]);
    store.set(sessionProcessingAtom('grandchild'), true);
    expect(store.get(sections)).toEqual({ Running: [group], 'Needs you': [], Idle: [idle] });
    store.set(sessionProcessingAtom('grandchild'), false);
    expect(store.get(sections).Idle).toEqual([group, idle]);
  });

  it('shows a blocked turn as waiting even while its transport reports processing', () => {
    const { store, sections } = setup();
    store.set(sessionProcessingAtom('child'), true);
    store.set(sessionHasPendingInteractivePromptAtom('child'), true);
    expect(store.get(sections)).toEqual({ Running: [], 'Needs you': [group], Idle: [idle] });
    store.set(sessionHasPendingInteractivePromptAtom('child'), false);
    expect(store.get(sections).Running).toEqual([group]);
  });

  it('prioritizes a running sibling over another descendant waiting for input', () => {
    const { store, sections } = setup();
    store.set(sessionHasPendingInteractivePromptAtom('grandchild'), true);
    store.set(sessionProcessingAtom('sibling'), true);
    expect(store.get(sections).Running).toEqual([group]);
    store.set(sessionProcessingAtom('sibling'), false);
    expect(store.get(sections)['Needs you']).toEqual([group]);
    expect(store.get(createWorkAttentionCountAtom(['root', 'child']))).toBe(1);
    expect(store.get(createWorkAttentionCountAtom(['root'], true))).toBe(1);
  });

  it('keeps queued work out of Idle without claiming it needs human input', () => {
    const { store, sections } = setup();
    store.set(sessionPendingPromptAtom('idle'), true);
    expect(store.get(sections)).toEqual({ Running: [idle], 'Needs you': [], Idle: [group] });
  });

  it('includes loaded descendants absent from the list snapshot, with cycle protection', () => {
    const { store, sections } = setup();
    store.set(sessionChildrenAtom('root'), ['unlisted']);
    store.set(sessionChildrenAtom('unlisted'), ['root']);
    store.set(sessionProcessingAtom('unlisted'), true);
    expect(store.get(sections).Running).toEqual([group]);
  });

  it('ignores archived descendants and preserves the incoming order within each section', () => {
    const { store, sections } = setup();
    const registry = new Map(store.get(sessionRegistryAtom));
    registry.set('grandchild', { ...registry.get('grandchild')!, isArchived: true });
    store.set(sessionRegistryAtom, registry);
    store.set(sessionProcessingAtom('grandchild'), true);
    expect(store.get(sections).Idle).toEqual([group, idle]);
    store.set(sessionProcessingAtom('root'), true);
    store.set(sessionProcessingAtom('idle'), true);
    expect(store.get(sections).Running).toEqual([group, idle]);
  });

  it('does not manufacture empty items or change group membership', () => {
    const store = createStore();
    const sections = createTodayActivityGroupsAtom([], () => []);
    expect(store.get(sections)).toEqual({ Running: [], 'Needs you': [], Idle: [] });
  });

  it.each(['review', 'blocked'] as const)('does not turn a generated %s summary into a human input request', attention => {
    const { store, sections } = setup();
    const registry = new Map(store.get(sessionRegistryAtom));
    registry.set('grandchild', { ...registry.get('grandchild')!, workSummary: { attention } as SessionWorkSummary });
    store.set(sessionRegistryAtom, registry);
    expect(store.get(sections)['Needs you']).toEqual([]);
    expect(store.get(sections).Idle).toEqual([group, idle]);
    expect(store.get(createWorkAttentionCountAtom(['root']))).toBe(0);
    store.set(sessionHasPendingInteractivePromptAtom('grandchild'), true);
    expect(store.get(sections)['Needs you']).toEqual([group]);
    expect(store.get(createWorkAttentionCountAtom(['root']))).toBe(1);
    store.set(sessionProcessingAtom('sibling'), true);
    expect(store.get(sections).Running).toEqual([group]);
    expect(store.get(sections).Idle).toEqual([idle]);
  });
});

describe('session scope search and filters', () => {
  const summary: SessionWorkSummary = { scope: 'Marilyst customization, context visibility and session navigation.', remaining: 'Install and verify the local build.', attention: 'review', areas: ['Navigation', 'Build performance'], state: 'ready', coverage: 'complete', updatedAt: 100, throughMessageId: 12 };
  const session = { title: 'Old session name', workSummary: summary };
  it('finds the whole-session scope, pending work and areas even when the title does not mention them', () => {
    expect(matchesSessionWorkSearch(session, 'context navigation')).toBe(true);
    expect(matchesSessionWorkSearch(session, 'install BUILD')).toBe(true);
    expect(matchesSessionWorkSearch(session, 'performance')).toBe(true);
    expect(matchesSessionWorkSearch(session, 'unrelated')).toBe(false);
  });
  it('supports remaining-work, review, blocker and exact area filters without inventing summaries', () => {
    expect(matchesWorkSummaryFilter(summary, 'review')).toBe(true);
    expect(matchesWorkSummaryFilter(summary, 'remaining')).toBe(true);
    expect(matchesWorkSummaryFilter(summary, 'blocked')).toBe(false);
    expect(matchesWorkSummaryFilter(summary, 'area:navigation')).toBe(true);
    expect(matchesWorkSummaryFilter(undefined, 'all')).toBe(true);
    expect(matchesWorkSummaryFilter(undefined, 'review')).toBe(false);
    expect(matchesWorkSummaryFilter({ ...summary, attention: 'none' }, 'remaining')).toBe(false);
    expect(matchesWorkSummaryFilter({ ...summary, attention: 'none', coverage: 'partial' }, 'remaining')).toBe(true);
  });
  it('validates SQLite text and rejects malformed or oversized metadata before rendering it', () => {
    expect(readSessionWorkSummary(JSON.stringify(summary))).toEqual(summary);
    expect(readSessionWorkSummary({ ...summary, scope: 'x'.repeat(221) })).toBeUndefined();
    expect(readSessionWorkSummary({ ...summary, attention: 'complete' })).toBeUndefined();
    expect(readSessionWorkSummary({ ...summary, evidencePath: { arbitrary: true } })).toBeUndefined();
  });
});
