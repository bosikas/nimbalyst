import { createHash } from 'crypto';
import { constants } from 'fs';
import { open, readdir } from 'fs/promises';
import { join } from 'path';
import {
  CodexStartupPrefixCollector,
  MAX_STARTUP_PREFIX_BYTES,
  codexRolloutDayCandidates,
  inspectCodexStartupRecords,
  type CodexRecordedStartup,
  type CodexRolloutRecord,
} from '@nimbalyst/runtime/ai/server/providers/codex/codexRecordedStartup';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * Read rollout records through the opening input. Reads raw bytes in bounded
 * chunks (never more than the cap plus one byte), refuses symlinks and
 * non-regular files, and fails fast on oversize, invalid UTF-8 or invalid JSON.
 */
export async function readCodexStartupPrefix(file: string, maxBytes = MAX_STARTUP_PREFIX_BYTES): Promise<CodexRolloutRecord[]> {
  let handle;
  try {
    // O_NONBLOCK: opening a FIFO must not block before fstat rejects it; no effect on regular-file reads.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('Rollout path is not a regular file.');
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Rollout path is not a regular file.');
    const collector = new CodexStartupPrefixCollector(maxBytes);
    let position = 0;
    for (let wanted = collector.wanted; wanted > 0; wanted = collector.wanted) {
      const buffer = Buffer.allocUnsafe(wanted);
      const { bytesRead } = await handle.read(buffer, 0, wanted, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      collector.push(buffer.subarray(0, bytesRead));
    }
    return collector.finish();
  } finally {
    await handle.close();
  }
}

/** Locate a rollout by thread id in its creation-day directories only; null when absent. */
export async function findCodexRollout(threadId: string, codexHome: string): Promise<string | null> {
  const days = codexRolloutDayCandidates(threadId);
  if (!days) return null;
  const suffix = `-${threadId.toLowerCase()}.jsonl`;
  for (const day of days) {
    const directory = join(codexHome, 'sessions', ...day);
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    const name = names.find(entry => entry.startsWith('rollout-') && entry.toLowerCase().endsWith(suffix));
    if (name) return join(directory, name);
  }
  return null;
}

/** Recorded startup for one Codex thread, or null when no local rollout exists. */
export async function readCodexRecordedStartup(threadId: string, codexHome: string, options: { maxTextBytes?: number } = {}): Promise<CodexRecordedStartup | null> {
  const source = await findCodexRollout(threadId, codexHome);
  if (!source) return null;
  const report = inspectCodexStartupRecords(await readCodexStartupPrefix(source), { ...options, fingerprint: sha256 });
  // The file name is only a lookup hint; the recorded session must be this thread.
  if (report.session.id?.toLowerCase() !== threadId.toLowerCase()) {
    throw new Error('Rollout session id does not match this thread; not showing another conversation.');
  }
  return { ...report, source };
}
