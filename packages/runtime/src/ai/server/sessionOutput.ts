import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MAX_BYTES = 24_000;
const MAX_LINES = 100;

export function sessionOutputFits(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') <= MAX_BYTES && text.split('\n').length <= MAX_LINES;
}

/** Bound the entire response, including its recovery instructions. Never elide before saving. */
export async function boundSessionOutput(full: string, preview = full, guidance = ''): Promise<string> {
  if (preview === full && sessionOutputFits(full)) return full;
  const directory = await mkdtemp(join(tmpdir(), 'nimbalyst-tool-output-'));
  const file = join(directory, 'full-output.txt');
  await writeFile(file, full, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  // Match the existing persisted-output convention: a readable full-output path,
  // followed by a preview. Include the pointer in the budget, not just the body.
  const notice = `Preview only. Full output saved to: ${file}\n${guidance || 'Read the file for complete details.'}\n\n`;
  let body = preview.split('\n').slice(0, MAX_LINES - notice.split('\n').length + 1).join('\n');
  // Iterate code points so neither UTF-8 nor surrogate pairs are split.
  const available = MAX_BYTES - Buffer.byteLength(notice, 'utf8');
  if (Buffer.byteLength(body, 'utf8') > available) {
    let bytes = 0;
    let clipped = '';
    for (const char of body) {
      bytes += Buffer.byteLength(char, 'utf8');
      if (bytes > available) break;
      clipped += char;
    }
    body = clipped;
  }
  return notice + body;
}
