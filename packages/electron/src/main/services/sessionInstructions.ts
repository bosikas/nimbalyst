import { open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { SessionInstructionOptions, SessionInstructionSnapshot } from '@nimbalyst/runtime/ai/sessionInstructions';

/** Resolve before inserting a session or creating a worktree. Never truncate instructions. */
export async function snapshotSessionInstructions(options: SessionInstructionOptions | undefined, workspacePath: string | undefined, provider: string, sessionType?: string): Promise<{
  skipDefaultInstructions: boolean;
  codexSourceHome?: string;
  nativeMultiAgent?: boolean;
  instructionSnapshot: SessionInstructionSnapshot | null;
}> {
  const { instructionFile, skipDefaultInstructions = false } = options ?? {};
  if (typeof skipDefaultInstructions !== 'boolean') throw new Error('skipDefaultInstructions must be a boolean.');
  if (instructionFile !== undefined && typeof instructionFile !== 'string') throw new Error('instructionFile must be a string.');
  const file = instructionFile?.trim();
  if ((file || skipDefaultInstructions) && (!['openai-codex', 'openai-codex-acp', 'claude-code'].includes(provider) || sessionType === 'claude-code-cli')) {
    throw new Error('Custom session instructions are supported by Codex and Claude Agent sessions on this Mac only.');
  }
  const selection = {
    skipDefaultInstructions,
    ...((provider === 'openai-codex' || provider === 'openai-codex-acp') && skipDefaultInstructions
      ? { codexSourceHome: path.resolve(process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex')) } : {}),
    ...(options?.nativeMultiAgent === true ? { nativeMultiAgent: true } : {}),
  };
  if (!file) return { ...selection, instructionSnapshot: null };
  if (!path.isAbsolute(file) && !workspacePath) throw new Error('A project folder is required for a relative instructionFile.');
  const canonicalPath = await realpath(path.resolve(workspacePath ?? '.', file));
  if (!/\.(md|markdown)$/i.test(canonicalPath)) throw new Error('Choose a Markdown instruction file (.md or .markdown).');
  const handle = await open(canonicalPath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error('instructionFile must be a regular Markdown file.');
    if (stat.size > 24_000) throw new Error('Instruction files must be at most 24,000 UTF-8 bytes. Split this profile explicitly; it was not truncated.');
    // A fixed-size read also bounds a file that grows between stat() and read().
    const buffer = Buffer.alloc(24_001);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 24_000) throw new Error('Instruction files must be at most 24,000 UTF-8 bytes.');
    const bytes = buffer.subarray(0, length);
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!content.trim()) throw new Error('The instruction file is empty.');
    return { ...selection, instructionSnapshot: { path: canonicalPath, content, sha256: createHash('sha256').update(bytes).digest('hex') } };
  } finally {
    await handle.close();
  }
}
