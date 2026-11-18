// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CodexStartupPrefixCollector, codexRolloutDayCandidates, inspectCodexStartupRecords } from '../codexRecordedStartup';

const baseline = 'You are Codex.';
const message = (text: string, kinds = ['model.base_instructions']) => ({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }] as any[], internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } });
const task = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate.' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } };

describe('recorded Codex startup', () => {
  it('counts a baseline stored in metadata and as a message once, and keeps settings out of message totals', () => {
    const report = inspectCodexStartupRecords([
      { type: 'session_meta', payload: { id: 'main', cli_version: '0.167.0', base_instructions: { text: baseline } } },
      message(baseline),
      { type: 'world_state', payload: { state: { agents_md: { text: 'rules' } } } },
      { type: 'turn_context', payload: { model: 'gpt', approvals_reviewer: 'auto_review', cwd: '/p' } },
      { type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt' } } },
      task,
      message('after the opening input'),
    ]);
    expect(report.snapshots.map(s => [s.line, s.name])).toEqual([
      [1, 'Session metadata: base instructions'],
      [3, 'Native state snapshot'],
      [4, 'Turn settings snapshot'],
      [5, 'Thread settings snapshot'],
    ]);
    expect(report.snapshots[0].sameTextAsMessageLine).toBe(2);
    expect(report.messages.map(m => m.line)).toEqual([2, 6]);
    expect(report.recordedMessageBytes).toBe(Buffer.byteLength(baseline + 'Investigate.'));
    expect(report.repeatedMessages).toEqual([]);
    expect(report.boundaryLine).toBe(6);
    expect(report.session).toMatchObject({ id: 'main', role: 'agent', model: 'gpt', runtimeVersion: '0.167.0' });
  });

  it('identifies the automatic approval reviewer as its own conversation', () => {
    const report = inspectCodexStartupRecords([
      { type: 'session_meta', payload: { id: 'review', source: { subagent: { other: 'guardian' } } } },
      { type: 'response_item', payload: { type: 'additional_tools', tools: [{ name: 'exec' }, { name: 'read' }] } },
      task,
    ]);
    expect(report.session.role).toBe('automatic-approval-reviewer');
    expect(report.toolRecords).toEqual([{ line: 2, bytes: expect.any(Number), definitions: 2 }]);
  });

  it('distinguishes rich content from the same flattened text and fingerprints the raw content', () => {
    const split = message('a');
    split.payload.content.push({ type: 'input_text', text: 'b' });
    const attachment = message('a\nb');
    attachment.payload.content.push({ type: 'input_image', image_url: 'local-image' });
    const report = inspectCodexStartupRecords([split, message('a\nb'), attachment, message('a\nb'), task], { fingerprint: text => `h(${text.length})` });
    expect(report.messages.slice(0, 4).map(m => [m.text, m.bytes])).toEqual([['a\nb', 2], ['a\nb', 3], ['a\nb', 3], ['a\nb', 3]]);
    expect(report.repeatedMessages).toEqual([{ lines: [2, 4], bytesPerMessage: 3 }]);
    expect(report.messages[0].sha256).toBe(`h(${JSON.stringify(split.payload.content).length})`);
    expect(inspectCodexStartupRecords([message('x')]).messages[0].sha256).toBeUndefined();
  });

  it('caps returned text on a character boundary without changing measured bytes', () => {
    const report = inspectCodexStartupRecords([message('ééé'), task], { maxTextBytes: 3 });
    expect(report.messages[0]).toMatchObject({ bytes: 6, text: 'é', textTruncated: true });
    expect(inspectCodexStartupRecords([message('ééé')], { maxTextBytes: 6 }).messages[0].textTruncated).toBe(false);
    expect(inspectCodexStartupRecords([message('ééé')]).boundaryLine).toBeNull();
  });

  it('collects the startup prefix from raw chunks within a byte cap', () => {
    const encode = (value: string) => new TextEncoder().encode(value);
    const prefix = `${JSON.stringify(message('café'))}\n${JSON.stringify(task)}\n`;
    const lines = `${prefix}${'z'.repeat(5000)}`;
    const collector = new CodexStartupPrefixCollector(1000);
    const raw = encode(lines);
    let offset = 0;
    // Split one byte at a time so a multi-byte character straddles chunks.
    while (collector.wanted > 0 && offset < raw.length) collector.push(raw.subarray(offset, ++offset));
    // Stops reading at the opening input's newline, before the later large record.
    expect(offset).toBe(encode(prefix).length);
    expect(collector.finish().map(r => r.payload.content[0].text)).toEqual(['café', 'Investigate.']);

    const noNewline = new CodexStartupPrefixCollector(100);
    expect(noNewline.wanted).toBeLessThanOrEqual(101);
    expect(() => noNewline.push(encode('x'.repeat(101)))).toThrow(/exceeds 100 bytes/);

    const finalLine = new CodexStartupPrefixCollector(1000);
    finalLine.push(encode(`${JSON.stringify(message('a'))}\r\n${JSON.stringify(message('b'))}`));
    expect(finalLine.finish()).toHaveLength(2);

    expect(() => new CodexStartupPrefixCollector(100).push(new Uint8Array([0x7b, 0xff, 0x7d, 0x0a]))).toThrow(/line 1 is not valid UTF-8/);
    expect(() => new CodexStartupPrefixCollector(100).push(encode('{broken\n'))).toThrow(/line 1 is not valid JSON/);
  });

  it('derives rollout day directories from a UUIDv7 thread id and rejects path-like ids', () => {
    const created = new Date(0x01a1e85446b0);
    const days = codexRolloutDayCandidates('01a1e854-46b0-7841-8b38-ab675abe8881');
    expect(days?.[0]).toEqual([String(created.getFullYear()), String(created.getMonth() + 1).padStart(2, '0'), String(created.getDate()).padStart(2, '0')]);
    expect(days).toHaveLength(3);
    expect(codexRolloutDayCandidates('01a1e854-46b0-4841-8b38-ab675abe8881')).toBeNull();
    expect(() => codexRolloutDayCandidates('../escape')).toThrow(/thread id/);
  });
});
