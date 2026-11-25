import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/types';
import type { SessionMessageAnchor } from '../../../shared/sessionNotificationNavigation';

const normalized = (text: string) => text.toLowerCase()
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[^\p{L}\p{N}#]+/gu, ' ').trim();

export function findTranscriptMessage(
  messages: readonly TranscriptViewMessage[],
  timestamp: number,
  anchor?: SessionMessageAnchor,
): number {
  if (!anchor) {
    return messages.findIndex(msg =>
      msg.type === 'user_message' && Math.abs((msg.createdAt?.getTime() || 0) - timestamp) < 1000
    );
  }
  if (anchor.kind === 'widget') {
    return messages.findIndex(msg => msg.type === 'interactive_prompt' && msg.interactivePrompt?.requestId === anchor.promptId);
  }
  if (typeof anchor.quote !== 'string' || !Number.isFinite(timestamp)) return -1;
  const quote = normalized(anchor.quote.slice(0, 2000));
  if (!quote) return -1;
  const matches = messages.flatMap((msg, index) => {
    if (msg.type !== `${anchor.kind}_message` || msg.optimistic || !msg.text) return [];
    if (!` ${normalized(msg.text)} `.includes(` ${quote} `)) return [];
    return [{ index, distance: Math.abs((msg.createdAt?.getTime() ?? 0) - timestamp) }];
  });
  // The final search row and the assembled transcript message can have
  // different timestamps. Prefer the matching occurrence nearest the source.
  matches.sort((a, b) => a.distance - b.distance);
  if (matches.length === 1 && matches[0].distance <= 120_000) return matches[0].index;
  return matches.length > 1 && matches[0].distance < 2000 && matches[0].distance < matches[1].distance
    ? matches[0].index : -1;
}
