import type { PromptResponse } from '@agentclientprotocol/sdk';
import type { ProtocolEvent } from '../ProtocolInterface';

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export function readVibeUsage(response: PromptResponse): ProtocolEvent['usage'] | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  const cached = count(usage.cachedReadTokens);
  return {
    input_tokens: Math.max(0, usage.inputTokens - (cached ?? 0)),
    output_tokens: usage.outputTokens,
    total_tokens: usage.totalTokens,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}),
  };
}

export function mapVibeSessionUpdate(
  update: Record<string, unknown>,
  resolveFilePath?: (filePath: string) => string,
): ProtocolEvent[] {
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const content = record(update.content);
      if (content?.type !== 'text' || typeof content.text !== 'string') return [];
      return [{ type: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'reasoning', content: content.text }];
    }
    case 'usage_update': {
      const contextFillTokens = count(update.used);
      const contextWindow = count(update.size);
      return contextFillTokens !== undefined && contextWindow
        ? [{ type: 'usage', contextFillTokens, contextWindow }]
        : [];
    }
    case 'tool_call': {
      if (typeof update.toolCallId !== 'string') return [];
      return [{
        type: 'tool_call',
        toolCall: {
          id: update.toolCallId,
          name: typeof update.title === 'string' ? update.title : 'Tool',
          arguments: record(update.rawInput),
        },
      }];
    }
    case 'tool_call_update': {
      if (typeof update.toolCallId !== 'string' || !['completed', 'failed'].includes(String(update.status))) return [];
      const changes = (Array.isArray(update.content) ? update.content : []).flatMap((item) => {
        const diff = record(item);
        if (diff?.type !== 'diff' || typeof diff.path !== 'string' || typeof diff.newText !== 'string') return [];
        return [{
          path: resolveFilePath?.(diff.path) ?? diff.path,
          kind: diff.oldText === null ? 'create' : 'update',
          ...(typeof diff.oldText === 'string' ? { beforeContent: diff.oldText } : {}),
          afterContent: diff.newText,
        }];
      });
      const output = update.rawOutput;
      const content = typeof output === 'string' ? output : output == null ? undefined : JSON.stringify(output);
      return [{
        type: 'tool_result',
        ...(update.status === 'completed' && update.title === 'Compacted conversation history'
          ? { metadata: { contextCompacted: true } }
          : {}),
        toolResult: {
          id: update.toolCallId,
          name: typeof update.title === 'string' ? update.title : '',
          result: { result: content, changes, success: update.status === 'completed' },
        },
      }];
    }
    default:
      return [];
  }
}
