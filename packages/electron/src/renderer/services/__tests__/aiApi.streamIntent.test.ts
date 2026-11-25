// @vitest-environment node
import { beforeAll, expect, it, vi } from 'vitest';

const { logIntent } = vi.hoisted(() => ({ logIntent: vi.fn() }));
vi.mock('../agentDocumentAccess', () => ({ applyAgentDiff: vi.fn() }));
vi.mock('../../utils/logger', () => ({
  logger: {
    api: { info: vi.fn() },
    protocol: { info: logIntent, warn: vi.fn() },
    streaming: { info: vi.fn(), warn: vi.fn() },
  },
}));

type ResponseHandler = (data: { partial?: string; content?: string; isComplete?: boolean }) => void;
let respond: ResponseHandler;
let api: typeof import('../aiApi').aiApi;

beforeAll(async () => {
  const electronAPI = new Proxy({}, {
    get: (_target, key) => key === 'onAIStreamResponse'
      ? (handler: ResponseHandler) => { respond = handler; }
      : vi.fn(),
  });
  vi.stubGlobal('window', { electronAPI });
  try {
    ({ aiApi: api } = await import('../aiApi'));
  } finally {
    vi.unstubAllGlobals();
  }
});

it('stops rescanning a long reply and detects a split editor marker in the next reply', () => {
  const onResponse = vi.fn();
  const onEdit = vi.fn();
  const onEditContent = vi.fn();
  api.on('streamResponse', onResponse);
  api.on('streamEditStart', onEdit);
  api.on('streamEditContent', onEditContent);
  vi.useFakeTimers();
  try {
    const first = { partial: 'a'.repeat(8192) };
    const second = { partial: 'b'.repeat(8192) };
    const final = { isComplete: true, content: first.partial + second.partial };
    respond(first);
    respond(second);
    respond(final);
    expect(logIntent.mock.calls.filter(([message]) => message === 'Detecting streaming intent in content:')).toHaveLength(1);
    expect(onResponse.mock.calls).toEqual([[first], [second], [final]]);

    respond({ partial: '<!-- STREAM_' });
    respond({ partial: 'EDIT: {"position":"cursor","mode":"after"} -->\ninserted text<!-- STREAM_END -->' });
    vi.runAllTimers();
    expect(onEdit).toHaveBeenCalledWith({ position: 'cursor', mode: 'after' });
    expect(onEditContent).toHaveBeenCalledWith('inserted text');
  } finally {
    vi.useRealTimers();
    api.off('streamResponse', onResponse);
    api.off('streamEditStart', onEdit);
    api.off('streamEditContent', onEditContent);
  }
});
