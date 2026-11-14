import { describe, expect, it } from 'vitest';
import { measureCodexContext, recordCodexContext, readCodexContext } from '../codexContextInspection';

describe('Codex context inspection', () => {
  it('measures UTF-8 payload categories and reasons without fabricating native token categories', () => {
    const snapshot = measureCodexContext('規則', { content: 'human request', toolOutputs: [{ name: 'coordination', output: '報告', retain: false }] }, 2, 1);
    expect(snapshot.categories.map(c => c.bytes)).toEqual([6, 13, 6]);
    expect(snapshot.categories.every(c => c.reason.length > 0)).toBe(true);
    expect(snapshot).not.toHaveProperty('nativeTokens');
    expect(snapshot.nativeContext).toMatch(/unavailable|opaque/i);
    expect(snapshot.attachments).toBe(1);
  });
  it('replaces snapshots instead of accumulating prior prompts and does not retain content', () => {
    recordCodexContext('s', measureCodexContext('rule', { content: 'SECRET original human request' }, 2, 0));
    recordCodexContext('s', measureCodexContext('rule', { content: 'next' }, 2, 0));
    expect(readCodexContext('s')?.categories[1].bytes).toBe(4);
    expect(JSON.stringify(readCodexContext('s'))).not.toContain('SECRET');
    expect(readCodexContext('missing')).toBeNull();
  });
});
