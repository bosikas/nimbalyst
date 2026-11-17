// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptWorkSummary, buildWorkSummaryInput, type WorkSummaryRecord, type WorkSummarySource } from '../sessionWorkSummary';
import { SessionWorkSummaryQueue } from '../sessionWorkSummaryQueue';
import { workSummaryCodexArgs, readWorkSummaryUsage } from '../codexWorkSummaryCompletion';
import { SessionSummaryDelivery, readSessionSummaryDraft } from '../sessionSummaryDelivery';
import { matchesWorkSummaryFilter } from '@nimbalyst/runtime/ai/sessionWorkSummary';

const source: WorkSummarySource = { title: 'Sidebar', throughMessageId: 12, requests: [{ id: '10', text: 'Improve sidebar navigation and preserve pending requests.', author: 'human' }], recent: [{ id: '12', role: 'assistant', text: 'Navigation implemented; installation still needs review.' }], partial: false, evidencePath: '/evidence/12.json' };
const output = { scope: 'Session navigation, context visibility and local build improvements.', remaining: 'Review the sidebar and install the local build.', attention: 'review', areas: ['Session navigation'], requests: [{ id: '10', status: 'pending', evidence: '12: Installation still needs review.' }] };
const accept = (overrides = {}, input = source, previous?: WorkSummaryRecord) => acceptWorkSummary(JSON.stringify({ ...output, ...overrides }), input, previous, 100);
afterEach(() => vi.useRealTimers());

it('requires a new submission for each host turn while ignoring repeated activity events', () => {
  const delivery = new SessionSummaryDelivery();
  const identity = {};
  delivery.started('session', identity);
  const revision = delivery.revision('session')!;
  delivery.accept('session', revision);
  delivery.started('session', identity);
  expect(delivery.submitted('session')).toBe(true);
  delivery.started('session', {});
  expect(delivery.submitted('session')).toBe(false);
  expect(() => delivery.accept('session', revision)).toThrow('another turn');
});

it('validates agent remaining work and keeps completed self-reports out of the remaining-work filter', () => {
  const draft = readSessionSummaryDraft({ scope: output.scope, remaining: '', attention: 'none', areas: ['Navigation', 'Navigation'] });
  expect(draft.areas).toEqual(['Navigation']);
  expect(() => readSessionSummaryDraft({ ...draft, attention: 'blocked' })).toThrow('Invalid summary');
  expect(() => readSessionSummaryDraft({ ...draft, scope: 'x'.repeat(221) })).toThrow('Invalid summary');
  expect(matchesWorkSummaryFilter({ ...accept().summary, ...draft, source: 'agent', coverage: 'partial' }, 'remaining')).toBe(false);
  expect(matchesWorkSummaryFilter({ ...accept().summary, ...draft, source: 'background', coverage: 'partial' }, 'remaining')).toBe(true);
});

it('records exact native usage and distinguishes unavailable cache measurements from zero', () => {
  expect(readWorkSummaryUsage(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1234, cached_input_tokens: 1000, output_tokens: 85 } }))).toEqual({ inputTokens: 1234, cachedInputTokens: 1000, outputTokens: 85 });
  expect(readWorkSummaryUsage(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1234, output_tokens: 85 } }))).toEqual({ inputTokens: 1234, outputTokens: 85 });
  expect(readWorkSummaryUsage('{bad')).toBeUndefined();
  expect(readWorkSummaryUsage(JSON.stringify({ type: 'item.completed', usage: { input_tokens: 1, output_tokens: 1 } }))).toBeUndefined();
  expect(readWorkSummaryUsage(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: -1, output_tokens: 1 } }))).toBeUndefined();
  expect(workSummaryCodexArgs('/tmp')).toContain('--json');
});

describe('whole-session scope and pending work', () => {
  it('keeps pending older human requests in the next input rather than only summarizing the last turn', () => {
    const previous = accept();
    const next = { ...source, requests: [], recent: [{ id: '13', role: 'assistant', text: 'Adjusted spacing.' }], throughMessageId: 13 };
    const input = JSON.parse(buildWorkSummaryInput(next, previous));
    expect(input.previous.scope).toBe(output.scope);
    expect(input.previous.requests.map((r: { id: string }) => r.id)).toEqual(['10']);
    expect(() => accept({ requests: [] }, next, previous)).toThrow(/omitted/);
  });
  it('rejects missing, duplicated and invented request identities', () => {
    expect(() => accept({ requests: [] })).toThrow(/omitted/);
    expect(() => accept({ requests: [output.requests[0], output.requests[0]] })).toThrow(/duplicated/);
    expect(() => accept({ requests: [{ ...output.requests[0], id: 'invented' }] })).toThrow(/identities/);
  });
  it('requires actual source references to resolve requests and does not infer done from a stopped turn', () => {
    expect(() => accept({ attention: 'none', remaining: '', requests: [{ id: '10', status: 'resolved', evidence: 'Agent phase: Complete' }] })).toThrow(/source evidence/);
    expect(accept({ attention: 'none', remaining: '' }).summary.attention).toBe('unknown');
    expect(accept({ attention: 'none', remaining: '', requests: [{ id: '10', status: 'resolved', evidence: '12: User reviewed the result.' }] }).summary.attention).toBe('none');
  });
  it('never hides unresolved work behind a contradictory no-work classification', () => {
    const result = accept({ attention: 'none' });
    expect(result.summary.attention).toBe('unknown');
    expect(result.summary.remaining).toBe(output.remaining);
  });
  it('marks truncated requests partial and keeps the evidence path without claiming completion', () => {
    const result = accept({ attention: 'none', remaining: '' }, { ...source, partial: true });
    expect(result.summary).toMatchObject({ coverage: 'partial', attention: 'unknown', evidencePath: source.evidencePath });
    expect(result.summary.remaining).toContain('review');
  });
  it('can finish catching up without permanently treating a complete request history as partial', () => {
    const first = accept({}, { ...source, catchingUp: true });
    expect(first.summary.coverage).toBe('partial');
    const next = accept({}, { ...source, requests: [], throughMessageId: 20 }, first);
    expect(next.summary.coverage).toBe('complete');
    const lossy = accept({}, { ...source, partial: true });
    expect(accept({}, { ...source, requests: [] }, lossy).summary.coverage).toBe('partial');
  });
  it('refuses oversized inference instead of silently dropping requests and avoids nested old reports', () => {
    expect(() => buildWorkSummaryInput({ ...source, requests: [{ id: '10', author: 'human', text: 'é'.repeat(11000) }] })).toThrow(/budget/);
    const previous = { ...accept(), unrelatedOldTranscript: 'old inbox history' };
    expect(buildWorkSummaryInput({ ...source, requests: [] }, previous)).not.toContain('old inbox history');
    expect(() => accept({ scope: 'x'.repeat(221) })).toThrow(/text/);
  });
});

describe('background lifecycle scheduling', () => {
  it('coalesces duplicate notifications, serializes across sessions, and processes a new turn arriving during inference', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const first = new Promise<void>(resolve => { release = resolve; });
    const run = vi.fn().mockImplementationOnce(async () => { await first; return false; }).mockResolvedValue(false);
    const queue = new SessionWorkSummaryQueue(run, error => { throw error; }, 1);
    queue.request('a', '/p'); queue.request('a', '/p');
    await vi.advanceTimersByTimeAsync(1);
    queue.request('a', '/p'); queue.request('b', '/p');
    expect(run).toHaveBeenCalledTimes(1);
    release(); await vi.runAllTimersAsync();
    expect(run.mock.calls).toEqual([['a', '/p'], ['a', '/p'], ['b', '/p']]);
  });
  it('continues bounded catch-up pages without another human prompt', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const queue = new SessionWorkSummaryQueue(run, vi.fn(), 1);
    queue.request('a', '/p'); await vi.runAllTimersAsync();
    expect(run).toHaveBeenCalledTimes(2);
  });
  it('isolates failures so another session still receives its summary', async () => {
    vi.useFakeTimers();
    const failed = vi.fn();
    const run = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(false);
    const queue = new SessionWorkSummaryQueue(run, failed, 1);
    queue.request('a', '/p'); queue.request('b', '/p'); await vi.runAllTimersAsync();
    expect(failed).toHaveBeenCalledOnce(); expect(run).toHaveBeenCalledTimes(2);
  });
  it('cancels scheduled work on application shutdown', async () => {
    vi.useFakeTimers();
    const run = vi.fn().mockResolvedValue(false);
    const queue = new SessionWorkSummaryQueue(run, vi.fn(), 1);
    queue.request('a', '/p'); queue.stop(); queue.request('b', '/p');
    await vi.runAllTimersAsync();
    expect(run).not.toHaveBeenCalled();
  });
  it('requests ephemeral read-only native inference with no working thread, plugins or shell', () => {
    const args = workSummaryCodexArgs('/tmp/summary', 'gpt-6.1-sol');
    expect(args).toEqual(expect.arrayContaining(['--ephemeral', '--ignore-user-config', '--sandbox', 'read-only', '--output-schema', '--model', 'gpt-6.1-sol']));
    expect(args.slice(args.indexOf('shell_tool') - 1, args.indexOf('shell_tool') + 1)).toEqual(['--disable', 'shell_tool']);
    expect(args).not.toContain('resume'); expect(args).not.toContain('--dangerously-bypass-approvals-and-sandbox');
  });
});
