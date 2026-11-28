import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzip } from 'node:zlib';
import {
  capRecordedStartupText,
  inspectCodexStartupRecords,
  type CodexRecordedMessage,
  type CodexRecordedStartup,
  type CodexRolloutRecord,
} from '@nimbalyst/runtime/ai/server/providers/codex/codexRecordedStartup';

const maxFileBytes = 1024 * 1024;
const maxCheckpointChunks = 4;
const maxCheckpointRecords = 128;
const maxConversationTextBytes = 256 * 1024;
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
  for (const digest of chunks.slice(0, maxCheckpointChunks)) {
    if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) return;
    const file = join(sessionDir, 'chunks', digest + '.json');
    const chunk = await readSnapshot(file + '.gz', true).catch(error =>
      error?.code === 'ENOENT' ? readSnapshot(file).catch(() => undefined) : undefined);
    if (!Array.isArray(chunk)) return;
    yield* chunk;
  }
}

interface VibeConversation {
  messages: CodexRecordedMessage[];
  limited: boolean;
}

interface VibeRecordedContext {
  report: CodexRecordedStartup;
  conversation: VibeConversation;
}

function contentText(block: Record<string, unknown> | undefined): string | undefined {
  const text = block?.text ?? object(block?.resource)?.text;
  if (typeof text === 'string') return text;
  if (block?.type === 'tool_call' && typeof block.name === 'string') {
    const args = object(block.arguments)?.raw;
    return typeof args === 'string' ? `${block.name}(${args})` : block.name;
  }
  if (block?.type === 'reasoning' && Array.isArray(block.content)) {
    const text = block.content.map(part => object(part)?.text).filter(part => typeof part === 'string').join('\n');
    return text || undefined;
  }
  return undefined;
}

async function readCheckpointMessages(sessionDir: string, generationDir: string, chunks: unknown, maxTextBytes: number) {
  const records: CodexRolloutRecord[] = [];
  const conversation: VibeConversation = { messages: [], limited: Array.isArray(chunks) && chunks.length > maxCheckpointChunks };
  let remaining = maxConversationTextBytes;
  let startup = true;
  let line = 0;
  for await (const item of checkpointEntries(sessionDir, generationDir, chunks)) {
    line++;
    const entry = object(item);
    const message = object(entry?.message);
    const role = message?.role;
    if (!entry || !message || typeof role !== 'string' || !Array.isArray(message.content)) continue;
    if ((typeof entry.turn_index === 'number' && entry.turn_index > 0) || role === 'assistant' || role === 'tool') startup = false;
    if (records.length + conversation.messages.length === maxCheckpointRecords || remaining <= 0) {
      conversation.limited = true;
      break;
    }
    const opening = startup && role === 'user' && message.context !== true && entry.source === 'history' && entry.turn_index === 0;
    const kinds: string[] = typeof message.name === 'string' ? [message.name] : [];
    const content = message.content.flatMap((part: unknown) => {
      const block = object(part);
      const resource = object(block?.resource);
      if (!block) return [];
      const kind = resource?.uri === 'nimbalyst://system-instructions'
        ? 'Nimbalyst instructions (ACP resource)'
        : opening && block?.type === 'text' ? 'user.text' : String(block?.type ?? 'text');
      kinds.push(kind);
      const text = contentText(block);
      return text === undefined ? [] : [{ type: block.type, text }];
    });
    if (startup) {
      records.push({ type: 'response_item', payload: {
        type: 'message', role, content, internal_chat_message_metadata_passthrough: { content_item_kinds: kinds },
      } });
      if (opening) startup = false;
    } else {
      const text = content.map(block => block.text).join('\n');
      const preview = capRecordedStartupText(text, Math.min(remaining, maxTextBytes));
      conversation.messages.push({ line, role, kinds, bytes: Buffer.byteLength(text), text: preview.text, textTruncated: preview.truncated });
      remaining -= Buffer.byteLength(preview.text);
    }
  }
  return { records, conversation };
}

/** Vibe's unified store persists the system instruction snapshot separately
 * from the ACP conversation. Older generations can retain the opening turn. */
export async function readVibeRecordedStartup(
  sessionDir: string,
  providerSessionId: string,
  maxTextBytes: number,
  selectedModel?: string,
): Promise<VibeRecordedContext | null> {
  const generationsDir = join(sessionDir, 'generations');
  const generations = (await readdir(generationsDir))
    .filter(name => /^\d{16}$/.test(name))
    .sort();
  let partial: VibeRecordedContext | null = null;
  for (const generation of new Set([generations.at(-1), ...generations.slice(0, 2)])) {
    if (!generation) continue;
    try {
      const directory = join(generationsDir, generation);
      const manifest = object(await readSnapshot(join(directory, 'manifest.json')));
      if (manifest?.session_id !== providerSessionId) continue;
      const runtime = object(await readSnapshot(join(directory, 'runtime-state.json')));
      if (runtime?.session_id !== providerSessionId) continue;
      const { records, conversation } = await readCheckpointMessages(sessionDir, directory, object(manifest.checkpoint)?.chunks, maxTextBytes);
      const report = inspectCodexStartupRecords(records, { maxTextBytes, fingerprint: hash });
      report.provider = 'mistral-vibe';
      report.session.id = providerSessionId;
      // Vibe's saved active_model can be its CLI default even after ACP selects another model.
      const model = selectedModel?.replace(/^mistral-vibe:/, '');
      if (model && model !== 'default') report.session.model = model;
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
      const evidence: VibeRecordedContext = {
        report,
        conversation: partial?.conversation.messages.length ? partial.conversation : conversation,
      };
      if (report.boundaryLine) return evidence;
      if (report.messages.length || report.snapshots.length || conversation.messages.length) partial ??= evidence;
    } catch {
      // Vibe can replace retained generations while this inspection runs.
    }
  }
  return partial;
}
