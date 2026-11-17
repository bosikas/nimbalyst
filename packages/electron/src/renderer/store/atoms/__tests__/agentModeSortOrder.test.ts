// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { mergeWithDefaults } from '../agentMode';

// Escape hatch for #924: a persisted sortOrder that the panel can't render must
// not brick the workspace on every launch. mergeWithDefaults is the single load
// path, so it coerces anything other than the two known values to 'updated'.
describe('mergeWithDefaults - sessionHistoryLayout.sortOrder (#924)', () => {
  it('opens Today and resets older date groups collapsed while retaining explicit tree and pinned choices', () => {
    const merged = mergeWithDefaults({ sessionHistoryLayout: { collapsedGroups: ['Today', 'Pinned', 'worktree:fixture'] } as never });
    expect(merged.sessionHistoryLayout.collapsedGroups).not.toContain('Today');
    expect(merged.sessionHistoryLayout.collapsedGroups).toEqual(expect.arrayContaining(['Yesterday', 'Last Week', 'Older', 'Pinned', 'worktree:fixture']));
  });
  it('preserves a valid "created" sortOrder', () => {
    const merged = mergeWithDefaults({
      sessionHistoryLayout: { sortOrder: 'created' } as never,
    });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('created');
  });

  it('preserves a valid "updated" sortOrder', () => {
    const merged = mergeWithDefaults({
      sessionHistoryLayout: { sortOrder: 'updated' } as never,
    });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('updated');
  });

  it('coerces an unknown/garbage persisted sortOrder to "updated"', () => {
    const merged = mergeWithDefaults({
      sessionHistoryLayout: { sortOrder: 'garbage' } as never,
    });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('updated');
  });

  it('defaults to "updated" when sortOrder is missing', () => {
    const merged = mergeWithDefaults({ sessionHistoryLayout: {} as never });
    expect(merged.sessionHistoryLayout.sortOrder).toBe('updated');
  });
});

describe('mergeWithDefaults - sessionHistoryLayout.compactRows', () => {
  it('fills an absent sidebar width without replacing a saved workspace width', () => {
    expect(mergeWithDefaults(undefined).sessionHistoryLayout.width).toBe(304);
    expect(mergeWithDefaults({ sessionHistoryLayout: { sortOrder: 'updated' } as never }).sessionHistoryLayout.width).toBe(304);
    expect(mergeWithDefaults({ sessionHistoryLayout: { width: 420 } as never }).sessionHistoryLayout.width).toBe(420);
  });
  it('keeps a saved compact preference and defaults older layouts to full rows', () => {
    expect(mergeWithDefaults({ sessionHistoryLayout: { compactRows: true } as never }).sessionHistoryLayout.compactRows).toBe(true);
    expect(mergeWithDefaults({ sessionHistoryLayout: { sortOrder: 'created' } as never }).sessionHistoryLayout.compactRows).toBe(false);
    expect(mergeWithDefaults(undefined).sessionHistoryLayout.compactRows).toBe(false);
  });
});

describe('mergeWithDefaults - sessionHistoryLayout.showContextUsage', () => {
  it('keeps a saved context-bar preference and defaults older layouts to off', () => {
    expect(mergeWithDefaults({ sessionHistoryLayout: { showContextUsage: true } as never }).sessionHistoryLayout.showContextUsage).toBe(true);
    expect(mergeWithDefaults({ sessionHistoryLayout: { compactRows: true } as never }).sessionHistoryLayout.showContextUsage).toBe(false);
  });
});
