// @vitest-environment jsdom
/**
 * Transcript rows and tool cards are memoized so a streamed text frame only
 * re-renders the row whose message changed. virtua wraps each item in a memo
 * keyed on the element, which never matches, so without this every visible
 * row and tool widget repaints once per frame. Nothing on screen shows the
 * waste, hence a test.
 */
import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptViewMessage } from '../../../../ai/server/types';
import { setTranscriptToolWidgets, clearTranscriptToolWidgets } from '../../contributions/TranscriptToolWidgetContributions';
import type { CustomToolWidgetProps } from '../CustomToolWidgets';
import { TranscriptToolCard, type SubagentChildContext, type TranscriptToolShared } from '../TranscriptToolCard';
import { TranscriptMessageRow, computeTranscriptRowInfos, type TranscriptRowInfo } from '../TranscriptMessageRow';
import { findToolActivityTarget } from '../../utils/toolActivity';

const segmentRenders = vi.hoisted(() => ({ byText: new Map<string, number>() }));

// Counts row renders: a message row renders exactly one MessageSegment.
vi.mock('../MessageSegment', () => ({
  MessageSegment: ({ message }: { message: TranscriptViewMessage }) => {
    const key = message.text ?? '';
    segmentRenders.byText.set(key, (segmentRenders.byText.get(key) ?? 0) + 1);
    return <div>{key}</div>;
  },
}));

let widgetRenders = 0;
const CountingWidget: React.FC<CustomToolWidgetProps> = ({ isExpanded }) => {
  widgetRenders++;
  return <div data-expanded={String(isExpanded)} />;
};

const shared: TranscriptToolShared = { sessionId: 's1', onToggleTool: () => {} };
const subagentContext: SubagentChildContext = { expandedTools: new Set(), skippedQuestionIds: new Set() };
const noop = () => {};

function msg(index: number, overrides: Partial<TranscriptViewMessage>): TranscriptViewMessage {
  return {
    id: index + 1,
    sequence: index + 1,
    createdAt: new Date(1_784_648_445_000 + index * 1000),
    type: 'assistant_message',
    subagentId: null,
    ...overrides,
  } as TranscriptViewMessage;
}

const toolMsg = msg(1, {
  type: 'tool_call',
  toolCall: {
    toolName: 'CountTool',
    toolDisplayName: 'CountTool',
    status: 'completed',
    description: null,
    arguments: {},
    targetFilePath: null,
    mcpServer: null,
    mcpTool: null,
    providerToolCallId: 'call-1',
    progress: [],
  } as unknown as TranscriptViewMessage['toolCall'],
});

function infosFor(messages: TranscriptViewMessage[], previous: TranscriptRowInfo[] | null, groupToolActivity = false, isWaitingForResponse = true) {
  return computeTranscriptRowInfos(messages, {
    showToolCalls: true,
    groupToolActivity,
    expandedTools: new Set(),
    supersededToolIndices: new Set(),
    skippedQuestionIds: subagentContext.skippedQuestionIds,
    subagentContext,
    isWaitingForResponse,
    restartAfterIndex: -1,
  }, previous);
}

function Rows({ messages, infos }: { messages: TranscriptViewMessage[]; infos: TranscriptRowInfo[]; tick: number }) {
  return (
    <>
      {messages.map((message, index) => (
        <TranscriptMessageRow
          key={message.id}
          message={message}
          index={index}
          info={infos[index]}
          isCollapsed={false}
          isCopied={false}
          showThinking
          compactMode={false}
          toolShared={shared}
          onToggleCollapse={noop}
          onCopy={noop}
          registerMessageRef={noop}
        />
      ))}
    </>
  );
}

describe('transcript row memoization', () => {
  it('coalesces adjacent orphan tools, preserving search targets and unchanged row identity', () => {
    const messages = [msg(0, { type: 'user_message', text: 'Inspect grouping' }), toolMsg,
      { ...toolMsg, id: 3 }, { ...toolMsg, id: 4 }];
    const grouped = infosFor(messages, null, true);
    expect(grouped.map(row => row.kind)).toEqual(['message', 'orphanTool', 'hidden', 'hidden']);
    expect(grouped[1].toolEntries?.map(entry => entry.index)).toEqual([1, 2, 3]);
    expect(findToolActivityTarget(grouped, 3)?.owner).toBe(1);
    const next = infosFor(messages, grouped, true);
    next.forEach((row, index) => expect(row).toBe(grouped[index]));
    expect(infosFor(messages, null).filter(row => row.kind === 'orphanTool')).toHaveLength(3);
  });
  it('does not merge across human requests, assistant narrative, thinking or questions', () => {
    const messages = [toolMsg, msg(1, { text: 'I found the issue.' }),
      { ...toolMsg, id: 3 }, msg(3, { text: '' }),
      msg(4, { type: 'user_message', text: 'Keep my request visible' }),
      { ...toolMsg, id: 6 }, msg(6, { thinking: 'Reasoning remains inspectable' })];
    const grouped = infosFor(messages, null, true);
    expect(grouped[1].kind).toBe('message');
    expect(grouped[3].kind).toBe('orphanTool');
    expect(grouped[4].kind).toBe('message');
    expect(grouped[6].kind).toBe('message');
    expect(grouped.filter(row => row.toolEntries).flatMap(row => row.toolEntries!.map(e => e.index))).toEqual([0, 2, 5]);
  });
  it('retains the completion footer when empty assistant envelopes are coalesced', () => {
    const messages = [msg(0, { type: 'user_message', text: 'Inspect files' }), toolMsg,
      msg(2, { text: '' }), { ...toolMsg, id: 4 }, msg(4, { text: '' })];
    const original = infosFor(messages, null, false, false);
    const grouped = infosFor(messages, null, true, false);
    expect(grouped[2].toolEntries?.map(entry => entry.index)).toEqual([1, 3]);
    expect(grouped[2].turn).toEqual(original[4].turn);
    expect(grouped[2].turn).not.toBeNull();
    const { getByText } = render(<Rows messages={messages} infos={grouped} tick={0} />);
    expect(getByText(/Finished in/).textContent).toContain(grouped[2].turn!.duration);
  });
  beforeEach(() => {
    widgetRenders = 0;
    segmentRenders.byText.clear();
    setTranscriptToolWidgets('render-cost-test', { CountTool: CountingWidget });
  });
  afterEach(() => { cleanup(); clearTranscriptToolWidgets('render-cost-test'); });

  it('a tool card re-renders its widget only when its own props change', () => {
    const card = (tick: number, isExpanded: boolean) => (
      <div data-tick={tick}>
        <TranscriptToolCard toolMsg={toolMsg} toolIndex={1} depth={0} isExpanded={isExpanded} superseded={false} shared={shared} />
      </div>
    );
    const { rerender } = render(card(0, false));
    rerender(card(1, false));
    expect(widgetRenders).toBe(1);
    rerender(card(2, true));
    expect(widgetRenders).toBe(2);
  });

  it('a streamed text patch re-renders only the changed row', () => {
    const messages = [
      msg(0, { type: 'user_message', text: 'first prompt' }),
      toolMsg,
      msg(2, { text: 'first answer' }),
      msg(3, { type: 'user_message', text: 'second prompt' }),
      msg(4, { text: 'streaming' }),
    ];
    const infos = infosFor(messages, null);
    expect(infos[1].kind).toBe('hidden'); // grouped under the assistant row
    expect(infos[2].toolEntries?.map(e => e.index)).toEqual([1]);

    const { rerender } = render(<Rows messages={messages} infos={infos} tick={0} />);
    // Parent re-render with nothing changed: no row renders.
    rerender(<Rows messages={messages} infos={infos} tick={1} />);
    expect(Object.fromEntries(segmentRenders.byText)).toEqual({
      'first prompt': 1, 'first answer': 1, 'second prompt': 1, streaming: 1,
    });

    // Accumulator publishes a new object for the streaming message and a new array.
    const patched = [...messages.slice(0, 4), { ...messages[4], text: 'streaming more' }];
    const patchedInfos = infosFor(patched, infos);
    expect(patchedInfos.slice(0, 4)).toEqual(infos.slice(0, 4));
    patchedInfos.slice(0, 4).forEach((info, i) => expect(info).toBe(infos[i]));

    rerender(<Rows messages={patched} infos={patchedInfos} tick={2} />);
    expect(Object.fromEntries(segmentRenders.byText)).toEqual({
      'first prompt': 1, 'first answer': 1, 'second prompt': 1, streaming: 1, 'streaming more': 1,
    });
    expect(widgetRenders).toBe(1);
  });
});
