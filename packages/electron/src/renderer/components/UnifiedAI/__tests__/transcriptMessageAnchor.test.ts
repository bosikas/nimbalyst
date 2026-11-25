import { describe, expect, it } from 'vitest';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import { findTranscriptMessage } from '../transcriptMessageAnchor';

const message = (type: TranscriptViewMessage['type'], time: number, text: string): TranscriptViewMessage =>
  ({ type, createdAt: new Date(time), text, id: time, sequence: time, subagentId: null });

describe('transcript message anchors', () => {
  it('preserves timestamp-only Quick Open navigation', () => {
    const messages = [message('assistant_message', 10_000, 'question'), message('user_message', 10_000, 'answer')];
    expect(findTranscriptMessage(messages, 10_000)).toBe(1);
  });

  it('finds the question in an assembled assistant message by exact excerpt', () => {
    const messages = [
      message('assistant_message', 10_000, 'Please pick a [policy](https://example.com). **Do we require a full review?**'),
      message('user_message', 50_000, 'Do we require a full review?'),
    ];
    expect(findTranscriptMessage(messages, 50_000, { timestamp: 50_000, kind: 'assistant', quote: 'Do we require a full review?' })).toBe(0);
  });

  it('uses the timestamp to disambiguate repeated replies and rejects a missing excerpt', () => {
    const messages = [message('user_message', 10_000, 'Use the full diff.'), message('user_message', 30_000, 'Use the full diff.')];
    const anchor = { timestamp: 31_000, kind: 'user', quote: 'Use the full diff.' } as const;
    expect(findTranscriptMessage(messages, 31_000, anchor)).toBe(1);
    expect(findTranscriptMessage(messages, 20_000, anchor)).toBe(-1);
    expect(findTranscriptMessage(messages, 31_000, { ...anchor, quote: 'Use a partial diff.' })).toBe(-1);
  });

  it('locates a question widget by its request ID', () => {
    const widget: TranscriptViewMessage = {
      ...message('interactive_prompt', 10_000, ''),
      interactivePrompt: { promptType: 'ask_user_question', requestId: 'prompt-id', questions: [], status: 'pending' },
    };
    expect(findTranscriptMessage([widget], 0, { timestamp: 0, kind: 'widget', promptId: 'prompt-id' })).toBe(0);
  });
});
