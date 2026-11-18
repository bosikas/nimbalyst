import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
// One pure parser for the in-app inspector and this offline report. Requires Node with type stripping (22.18+).
import { CodexStartupPrefixCollector, inspectCodexStartupRecords } from '../../../packages/runtime/src/ai/server/providers/codex/codexRecordedStartup.ts';

const fingerprint = text => createHash('sha256').update(text).digest('hex');

/** Recorded startup evidence, not a reconstruction of the outbound API request. */
export const inspectStartupRecords = records => inspectCodexStartupRecords(records, { fingerprint });

async function readStartupPrefix(source) {
  // Same bounded byte reader as the app: at most 4 MB + 1 byte, symlinks and non-regular files refused.
  // O_NONBLOCK: opening a FIFO must not block before fstat rejects it; no effect on regular-file reads.
  const handle = await open(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Rollout path is not a regular file.');
    const collector = new CodexStartupPrefixCollector();
    let position = 0;
    for (let wanted = collector.wanted; wanted > 0; wanted = collector.wanted) {
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      collector.push(buffer.subarray(0, bytesRead));
    }
    return collector.finish();
  } finally { await handle.close(); }
}

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export function renderStartupInspection(report) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Recorded startup inspection</title>
<style>body{font:16px system-ui;max-width:1100px;margin:40px auto;padding:0 20px;color:#202124;background:#fafafa}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px monospace}details{border:1px solid #ccc;padding:12px;margin:12px 0}summary{cursor:pointer}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left;border-bottom:1px solid #ccc}</style>
<h1>Recorded startup inspection</h1><p>${escapeHtml(report.session.id)} · ${escapeHtml(report.session.role)} · ${escapeHtml(report.session.model ?? 'model unavailable')}</p>
<p>Recorded evidence is not proof of the complete outbound request. UTF-8 bytes are not tokens. Snapshots and tool records are separate representations and must not be added to message bytes as native usage. Transport roles and user.text labels do not establish human authorship or authorization; approval-review inputs can be machine-generated.</p>
<h2>Recorded messages</h2><p>${report.messages.length} records · ${report.recordedMessageBytes.toLocaleString()} text bytes · ${report.boundaryLine ? `through opening input at source line ${report.boundaryLine}` : 'opening input not found; capture may be incomplete'}.</p>
${report.messages.map(entry => `<details><summary>Line ${entry.line}: ${escapeHtml(entry.role)} · ${entry.bytes.toLocaleString()} bytes · ${escapeHtml(entry.kinds.join(', ') || 'provenance unavailable')}</summary><pre>${escapeHtml(entry.text)}</pre></details>`).join('')}
<h2>Audit snapshots — excluded from message totals</h2><table><tr><th>Source</th><th>Bytes</th><th>Overlap</th></tr>${report.snapshots.map(entry => `<tr><td>Line ${entry.line}: ${escapeHtml(entry.name)}</td><td>${entry.bytes}</td><td>${entry.sameTextAsMessageLine ? `Same text as recorded message at line ${entry.sameTextAsMessageLine}; one instruction body, counted once` : 'Settings or state record; not a message and not partitionable into message usage'}</td></tr>`).join('')}</table>
<h2>Tool records — separate from text messages</h2><p>${report.toolRecords.length} recorded tool-definition blocks (${report.toolRecords.reduce((sum, block) => sum + block.definitions, 0)} definitions, ${report.toolRecords.reduce((sum, block) => sum + block.bytes, 0).toLocaleString()} JSON bytes). Bytes measure their local JSON representation, not provider token allocation.</p>
<h2>Repeated recorded messages</h2><p>${report.repeatedMessages.length ? escapeHtml(report.repeatedMessages.map(group => `Matching role, provenance and text at lines ${group.lines.join(', ')} (${group.bytesPerMessage} bytes each)`).join('; ')) : 'No identical message records with matching role and provenance found in this prefix.'} Repetition in a log does not by itself prove duplicate delivery to a model.</p></html>`;
}

async function main() {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) throw new Error('Usage: node scripts/manual-tests/agent-startup-context/inspect.mjs <rollout.jsonl> <new-report.html>');
  const report = inspectStartupRecords(await readStartupPrefix(source));
  await writeFile(destination, renderStartupInspection(report), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ source, destination, session: report.session, messages: report.messages.length, recordedMessageBytes: report.recordedMessageBytes, snapshots: report.snapshots.length, repeatedMessages: report.repeatedMessages, boundaryLine: report.boundaryLine }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
