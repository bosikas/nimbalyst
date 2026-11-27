import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import {
  capRecordedStartupText,
  inspectCodexStartupRecords,
  type CodexRecordedStartup,
  type CodexRolloutRecord,
} from '@nimbalyst/runtime/ai/server/providers/codex/codexRecordedStartup';

const maxFileBytes = 1024 * 1024;
const maxOpeningChunks = 4;
const decompress = promisify(gunzip);
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;

async function readSnapshot(file: string, compressed = false): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxFileBytes) return undefined;
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== stat.size) return undefined;
    const bytes = buffer.subarray(0, bytesRead);
    const contents = compressed ? await decompress(bytes, { maxOutputLength: maxFileBytes }) : bytes;
    return JSON.parse(contents.toString('utf8'));
  } finally {
    await handle.close();
  }
}

async function* checkpointEntries(sessionDir: string, generationDir: string, chunks: unknown): AsyncIterable<unknown> {
  if (!Array.isArray(chunks)) {
    const checkpoint = object(await readSnapshot(join(generationDir, 'checkpoint.json')).catch(() => undefined));
    const messages = object(checkpoint?.context)?.messages;
    if (Array.isArray(messages)) yield* messages;
    return;
  }
  for (const digest of chunks.slice(0, maxOpeningChunks)) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return;
    const file = join(sessionDir, 'chunks', digest + '.json');
    const chunk = await readSnapshot(file + '.gz', true).catch(error =>
      error?.code === 'ENOENT' ? readSnapshot(file).catch(() => undefined) : undefined);
    if (!Array.isArray(chunk)) return;
    yield* chunk;
  }
}

async function openingRecords(sessionDir: string, generationDir: string, manifest: Record<string, unknown>): Promise<CodexRolloutRecord[]> {
  const records: CodexRolloutRecord[] = [];
  // Checkpoint entries are in message order. Stop before any later turns.
  for await (const item of checkpointEntries(sessionDir, generationDir, object(manifest.checkpoint)?.chunks)) {
    const entry = object(item);
    const message = object(entry?.message);
    const role = message?.role;
    if (!entry || !message || !Array.isArray(message.content)) continue;
    if (typeof entry.turn_index === 'number' && entry.turn_index > 0) return records;
    if (role !== 'system' && role !== 'developer' && role !== 'user') continue;
    const opening = role === 'user' && message.context !== true && entry.source === 'history' && entry.turn_index === 0;
    const kinds: string[] = [];
    const content = message.content.flatMap((part: unknown) => {
      const block = object(part);
      const resource = object(block?.resource);
      const text = block?.text ?? resource?.text;
      if (typeof text !== 'string') return [];
      const kind = resource?.uri === 'nimbalyst://system-instructions'
        ? 'Nimbalyst instructions (ACP resource)'
        : opening && block?.type === 'text' ? 'user.text' : String(block?.type ?? 'text');
      kinds.push(kind);
      return [{ type: block?.type, text }];
    });
    records.push({ type: 'response_item', payload: {
      type: 'message', role, content, internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
    } });
    if (opening) return records;
  }
  return records;
}

/** Vibe's unified store persists the system instruction snapshot separately
 * from the ACP conversation. Older generations can retain the opening turn. */
export async function readVibeRecordedStartup(
  sessionDir: string,
  providerSessionId: string,
  maxTextBytes: number,
): Promise<CodexRecordedStartup | null> {
  const generationsDir = join(sessionDir, 'generations');
  const generations = (await readdir(generationsDir))
    .filter(name => /^\d{16}$/.test(name))
    .sort().slice(0, 2);
  let partial: CodexRecordedStartup | null = null;
  for (const generation of generations) {
    try {
      const directory = join(generationsDir, generation);
      const manifest = object(await readSnapshot(join(directory, 'manifest.json')));
      if (manifest?.session_id !== providerSessionId) continue;
      const runtime = object(await readSnapshot(join(directory, 'runtime-state.json')));
      if (runtime?.session_id !== providerSessionId) continue;
      const records = await openingRecords(sessionDir, directory, manifest);
      const report = inspectCodexStartupRecords(records, { maxTextBytes, fingerprint: hash });
      report.provider = 'mistral-vibe';
      report.session.id = providerSessionId;
      const model = object(runtime.session_metadata)?.active_model;
      if (typeof model === 'string') report.session.model = model;
      const system = runtime.core_system_instructions;
      if (typeof system === 'string' && system) {
        const preview = capRecordedStartupText(system, maxTextBytes);
        report.snapshots.push({
          line: 0,
          name: 'Saved Vibe system instructions',
          bytes: Buffer.byteLength(system),
          sha256: hash(system),
          text: preview.text,
          textTruncated: preview.truncated,
        });
      }
      if (report.boundaryLine) return report;
      if (report.messages.length || report.snapshots.length) partial ??= report;
    } catch {
      // Vibe can replace retained generations while this inspection runs.
    }
  }
  return partial;
}
