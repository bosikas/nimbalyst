// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { measureCodexContext, recordCodexContext, readCodexContext, observeCodexContextNotifications, readCodexContextEvidence } from '../codexContextInspection';

describe('Codex context inspection', () => {
  it('compares reported usage around verified compaction without retaining prompts or inventing missing usage', () => {
    let receive!: (method: string, params: unknown) => void;
    observeCodexContextNotifications({ onNotification: cb => { receive = cb; return () => {}; } }, 'comparison', () => 'native-thread');
    const usage = (tokens: number, threadId = 'native-thread') => receive('thread/tokenUsage/updated', { threadId, tokenUsage: { last: { totalTokens: tokens } } });
    usage(9000);
    receive('item/started', { threadId: 'foreign', item: { id: 'foreign', type: 'contextCompaction' } });
    receive('item/started', { threadId: 'native-thread', item: { id: 'compact-1', type: 'contextCompaction', text: 'SECRET summary' } });
    expect(readCodexContextEvidence('comparison').compactions[0]).toMatchObject({ beforeTokens: 9000, afterTokens: null });
    usage(1, 'foreign');
    receive('item/completed', { threadId: 'native-thread', item: { id: 'compact-1', type: 'contextCompaction' } });
    usage(3000);
    usage(5000);
    const evidence = readCodexContextEvidence('comparison');
    expect(evidence.compactions).toHaveLength(1);
    expect(evidence.compactions[0]).toMatchObject({ beforeTokens: 9000, afterTokens: 3000 });
    expect(JSON.stringify(evidence)).not.toContain('SECRET');
    expect(evidence).not.toHaveProperty('tokenCategories');
  });
  it('records observed MCP calls once by native item id, independent of configuration or prompt text', () => {
    let receive!: (method: string, params: unknown) => void;
    observeCodexContextNotifications({ onNotification: cb => { receive = cb; return () => {}; } }, 'tools', () => 't');
    const params = { threadId: 't', item: { id: 'call', type: 'mcpToolCall', server: 'deferred', tool: 'search', arguments: { secret: 'SECRET' } } };
    receive('item/started', params);
    receive('item/completed', params);
    receive('item/started', { ...params, threadId: 'foreign' });
    expect(readCodexContextEvidence('tools').observedTools).toEqual([expect.objectContaining({ server: 'deferred', tool: 'search', calls: 1 })]);
    expect(JSON.stringify(readCodexContextEvidence('tools'))).not.toContain('SECRET');
    expect(readCodexContextEvidence('unobserved').observedTools).toEqual([]);
  });
  it('bounds diagnostic retention, preserves zero usage, and does not mutate returned evidence', () => {
    let receive!: (method: string, params: unknown) => void;
    observeCodexContextNotifications({ onNotification: cb => { receive = cb; return () => {}; } }, 'bounded-evidence', () => 't');
    for (let i = 0; i < 25; i++) {
      receive('item/started', { threadId: 't', item: { id: `c${i}`, type: 'contextCompaction' } });
      receive('item/completed', { threadId: 't', item: { id: `c${i}`, type: 'contextCompaction' } });
      receive('thread/tokenUsage/updated', { threadId: 't', tokenUsage: { last: { total_tokens: 0 } } });
    }
    for (let i = 0; i < 205; i++) receive('item/started', { threadId: 't', item: { id: `tool${i}`, type: 'mcpToolCall', server: 'fixture', tool: `tool${i}` } });
    const evidence = readCodexContextEvidence('bounded-evidence');
    expect(evidence.compactions).toHaveLength(20);
    expect(evidence.compactions[0]).toMatchObject({ id: 'c24', beforeTokens: 0, afterTokens: 0 });
    expect(evidence.observedTools).toHaveLength(200);
    expect(evidence.omittedToolCalls).toBe(5);
    evidence.compactions[0].beforeTokens = 100;
    expect(readCodexContextEvidence('bounded-evidence').compactions[0].beforeTokens).toBe(0);
  });
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
