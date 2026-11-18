import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectStartupRecords, renderStartupInspection } from './inspect.mjs';

const baseline = 'You are Codex.';
const message = (text, kinds = ['model.base_instructions']) => ({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text }], internal_chat_message_metadata_passthrough: { content_item_kinds: kinds } } });
const task = { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Investigate.' }], internal_chat_message_metadata_passthrough: { content_item_kinds: ['user.text'] } } };

test('separates metadata from messages without reporting a duplicated delivered baseline', () => {
  const report = inspectStartupRecords([
    { type: 'session_meta', payload: { id: 'main', base_instructions: { text: baseline } } },
    message(baseline), task, message('Later instructions'),
  ]);
  assert.equal(report.messages.length, 2);
  assert.equal(report.snapshots[0].sameTextAsMessageLine, 2);
  assert.equal(report.repeatedMessages.length, 0);
  assert.equal(report.recordedMessageBytes, Buffer.byteLength(baseline + 'Investigate.'));
  assert.equal(report.boundaryLine, 3);
  assert.match(report.messages[0].sha256, /^[0-9a-f]{64}$/);
});

test('retains genuinely repeated message records and measures UTF-8 bytes', () => {
  const report = inspectStartupRecords([message('é'), message('é'), task]);
  assert.deepEqual(report.repeatedMessages, [{ lines: [1, 2], bytesPerMessage: 2 }]);
  assert.equal(report.recordedMessageBytes, 2 + 2 + Buffer.byteLength('Investigate.'));
});

test('identifies a separate automatic approval reviewer and tool definitions', () => {
  const report = inspectStartupRecords([
    { type: 'session_meta', payload: { id: 'review', source: { subagent: { other: 'guardian' } } } },
    { type: 'response_item', payload: { type: 'additional_tools', tools: [{ name: 'exec' }] } },
    { type: 'turn_context', payload: { model: 'codex-auto-review', approvals_reviewer: 'auto_review' } }, task,
  ]);
  assert.equal(report.session.role, 'automatic-approval-reviewer');
  assert.equal(report.session.model, 'codex-auto-review');
  assert.deepEqual(report.toolRecords.map(block => block.definitions), [1]);
  assert.equal(report.messages.length, 1);
  // Settings are audit snapshots, rendered outside the message totals.
  assert.deepEqual(report.snapshots.map(snapshot => snapshot.name), ['Turn settings snapshot']);
  const html = renderStartupInspection(report);
  assert.ok(html.indexOf('Turn settings snapshot') > html.indexOf('excluded from message totals'));
});

test('does not count display separators or confuse matching text with matching content', () => {
  const split = message('a');
  split.payload.content.push({ type: 'input_text', text: 'b' });
  const joined = message('a\nb');
  const attachment = message('a\nb');
  attachment.payload.content.push({ type: 'input_image', image_url: 'local-image' });
  const report = inspectStartupRecords([split, joined, attachment, task]);
  assert.equal(report.messages[0].bytes, 2);
  assert.equal(report.messages[1].bytes, 3);
  assert.equal(report.messages[2].bytes, 3);
  assert.deepEqual(report.repeatedMessages, []);
  assert.equal(inspectStartupRecords([{ type: 'response_item', payload: { type: 'message', role: 'developer' } }, task]).messages[0].bytes, 0);
});

test('keeps machine opening input distinct and safely renders untrusted transcript text', () => {
  const report = inspectStartupRecords([
    message('<script>alert(1)</script>'),
    { type: 'response_item', payload: { type: 'function_call_output', output: 'Machine instruction' } },
    message('After boundary'),
  ]);
  assert.equal(report.messages[1].role, 'tool');
  const html = renderStartupInspection(report);
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(!html.includes('<script>'));
  assert.ok(html.includes('not proof of the complete outbound request'));
});
