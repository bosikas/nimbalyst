import { describe, expect, it } from 'vitest';
import { measureToolList } from '../mcpTokenBudget';
describe('tool schema byte measurement', () => {
  it('measures real UTF-8 bytes separately from the character-based token estimate', () => {
    const tool = { name: 'search', description: '日本語 🔍', inputSchema: { type: 'object' } };
    const serialized = JSON.stringify([tool]);
    expect(measureToolList([tool]).bytes).toBe(Buffer.byteLength(serialized, 'utf8'));
    expect(measureToolList([tool]).estTokens).toBe(Math.ceil(serialized.length / 4));
  });
});
