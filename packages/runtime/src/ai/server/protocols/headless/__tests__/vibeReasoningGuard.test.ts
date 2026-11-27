import { describe, expect, it } from 'vitest';
import { createVibeReasoningGuard } from '../vibeReasoningGuard';

const paragraph = 'The heading is in the file, so the first edit landed. The next edit expected the old sentence to wrap across two lines, but the current section prints it on one line. Did the last edit touch the earlier heading or the final bullet? The terminal shows the new heading and the unchanged bullet. I should reread that bullet and match the line currently on disk. The previous replacement could not match the line break it expected.';

function streamReasoning(guard: ReturnType<typeof createVibeReasoningGuard>, text: string): string | undefined {
  for (let offset = 0; offset < text.length; offset += 13) {
    const interruption = guard({ type: 'reasoning', content: text.slice(offset, offset + 13) });
    if (interruption) return interruption;
  }
  return undefined;
}

describe('Vibe reasoning guard', () => {
  it('interrupts a short paragraph loop on the third consecutive copy', () => {
    const guard = createVibeReasoningGuard();
    expect(streamReasoning(guard, `${paragraph}\n`.repeat(2))).toBeUndefined();
    expect(streamReasoning(guard, `${paragraph}\n`)).toContain('repeating its reasoning');
  });

  it('allows reasoning to revisit the same passage after a tool call', () => {
    const guard = createVibeReasoningGuard();
    expect(streamReasoning(guard, `${paragraph}\n`.repeat(2))).toBeUndefined();
    guard({ type: 'tool_call' });
    expect(streamReasoning(guard, `${paragraph}\n`.repeat(2))).toBeUndefined();
  });
});
