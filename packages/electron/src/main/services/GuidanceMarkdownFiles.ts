import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readSync, writeSync } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

/** Upper bound for any guidance source. Legacy prose was capped at 100,000 UTF-16 units (at most 400 KB of UTF-8). */
export const MAX_GUIDANCE_FILE_BYTES = 512 * 1024;
const MARKDOWN_EXTENSION = /\.(md|markdown)$/i;

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a selected guidance source as bounded, strict UTF-8 from a regular Markdown file.
 * Throws with the path on any problem; callers decide whether to surface or fail the prompt.
 */
export function readGuidanceMarkdown(filePath: unknown): string {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) throw new Error('Guidance source must be an absolute file path.');
  if (!MARKDOWN_EXTENSION.test(filePath)) throw new Error(`Guidance source must be a Markdown file (.md or .markdown): ${filePath}`);
  let fd: number;
  try {
    // O_NONBLOCK keeps a FIFO from blocking the main process; fstat below rejects it.
    fd = openSync(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  } catch (error) {
    throw new Error(`Cannot open guidance source ${filePath}: ${describe(error)}`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`Guidance source is not a regular file: ${filePath}`);
    if (stat.size > MAX_GUIDANCE_FILE_BYTES) throw new Error(`Guidance source exceeds ${MAX_GUIDANCE_FILE_BYTES} bytes: ${filePath}`);
    // Read one byte past the limit so a file that grew after fstat is still rejected.
    const buffer = Buffer.alloc(MAX_GUIDANCE_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_GUIDANCE_FILE_BYTES) throw new Error(`Guidance source exceeds ${MAX_GUIDANCE_FILE_BYTES} bytes: ${filePath}`);
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, length));
    } catch {
      throw new Error(`Guidance source is not valid UTF-8 text: ${filePath}`);
    }
    if (text.includes('\u0000')) throw new Error(`Guidance source contains binary data: ${filePath}`);
    if (!text.trim()) throw new Error(`Guidance source is empty: ${filePath}. Use the toggle to disable a section.`);
    return text;
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes a new, never-overwritten version and verifies it reads back byte-for-byte.
 * Earlier versions stay on disk so a failed save or a reset never destroys user text.
 */
export function writeGuidanceVersion(directory: string, stem: string, text: string): string {
  if (!path.isAbsolute(directory)) throw new Error('Guidance directory must be absolute.');
  if (!/^[a-z0-9-]+$/.test(stem)) throw new Error(`Invalid guidance file name: ${stem}`);
  if (typeof text !== 'string' || !text.trim()) throw new Error('Instructions must not be empty. Use the toggle to disable a section.');
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length > MAX_GUIDANCE_FILE_BYTES) throw new Error(`Instructions exceed ${MAX_GUIDANCE_FILE_BYTES} bytes.`);
  if (bytes.toString('utf8') !== text) throw new Error('Instructions contain characters that cannot be stored as UTF-8.');
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `${stem}-${stamp}-${randomUUID().slice(0, 8)}.md`);
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (readGuidanceMarkdown(filePath) !== text) throw new Error(`Saved instructions did not read back identically: ${filePath}`);
  return filePath;
}

/** A recoverable copy of a settings value before it is removed from the settings store. */
export function writeGuidanceBackup(directory: string, name: string, value: unknown): string {
  mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(directory, `${name}-${stamp}-${randomUUID().slice(0, 8)}.json`);
  const fd = openSync(filePath, 'wx', 0o600);
  try {
    const bytes = Buffer.from(JSON.stringify(value, null, 2), 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  return filePath;
}
