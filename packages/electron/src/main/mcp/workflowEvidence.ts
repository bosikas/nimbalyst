import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { AGENT_ADDENDUM_VERSION } from '@nimbalyst/runtime/ai/prompt';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';

const skills = ['coordinate', 'deliver', 'pr-review'] as const;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_RECEIPT_BYTES = 64 * 1024;
const nativeProviders: Readonly<Record<string, string>> = {
  'claude-code': 'claude',
  'claude-code-cli': 'claude',
  'openai-codex': 'codex',
  'mistral-vibe': 'vibe',
  'opencode': 'opencode',
};

type Session = NonNullable<Awaited<ReturnType<typeof AISessionsRepository.get>>>;

interface Receipt {
  name: string;
  worktree: string;
  result: 'ran' | 'blocked' | 'failed' | 'read' | 'checkpoint';
  reason: string;
  timestamp: string;
  sourceDigest?: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function receiptPath(kind: 'hook' | 'skill', sessionKey: string): string {
  const state = process.env.XDG_STATE_HOME;
  const root = state && isAbsolute(state) ? state : join(homedir(), '.local', 'state');
  return join(root, 'ai-setup', kind + '-receipts', digest(sessionKey) + '.jsonl');
}

async function readBoundedSource(path: string): Promise<string> {
  if (!(await stat(path)).isFile()) throw new Error('Expected an instruction file.');
  const handle = await open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error('Expected a small instruction file.');
    const buffer = Buffer.alloc(stat.size + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > stat.size) throw new Error('Instruction file changed during the read.');
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

function inside(root: string, path: string): boolean {
  const name = relative(root, path);
  return !!name && !isAbsolute(name) && name !== '..' && !name.startsWith('../') && !name.startsWith('..\\');
}

async function workflowSkillPath(worktree: string, name: string): Promise<string> {
  const root = await realpath(worktree);
  const file = await realpath(join(root, '.agents', 'skills', name, 'SKILL.md'));
  if (inside(root, file)) return file;

  // The managed overlay links both AGENTS.md and its skills from one AI-Setup profile.
  const project = dirname(await realpath(join(root, 'AGENTS.md')));
  if (file === join(project, 'tools', name, 'SKILL.md') && project.endsWith(join('projects', 'aifredas'))) {
    return file;
  }
  throw new Error('The skill source is outside this worktree and its managed profile.');
}

const pending = new Map<string, { digest: string; offset: number }>();

function skillPage(text: string, offset: number) {
  let end = offset;
  let bytes = 0;
  let lines = 0;
  for (const character of text.slice(offset)) {
    bytes += Buffer.byteLength(JSON.stringify(character)) - 2;
    if (bytes > 5500 || lines >= 15) break;
    end += character.length;
    if (character === '\n') lines++;
  }
  return { text: text.slice(offset, end), end };
}

async function managedSkill(sessionId: string, workspace: string, name: unknown) {
  if (!skills.some(skill => skill === name) || typeof name !== 'string') {
    throw new Error('Choose coordinate, deliver, or pr-review.');
  }
  const session = await AISessionsRepository.get(sessionId);
  if (!workspace || !session?.workspacePath || !sameWorkspaceIdentity(session.workspacePath, workspace)) {
    throw new Error('A session in this workspace is required.');
  }
  const worktree = session.worktreePath ?? session.workspacePath;
  const source = await readBoundedSource(await workflowSkillPath(worktree, name));
  return { name, worktree, source, hash: digest(source) };
}

async function appendSkillReceipt(sessionId: string, receipt: Receipt) {
  const file = receiptPath('skill', sessionId);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify(receipt) + '\n', { mode: 0o600 });
}

export async function readWorkflowSkill(sessionId: string, workspace: string, skill: unknown, offset: unknown) {
  const { name, worktree, source, hash } = await managedSkill(sessionId, workspace, skill);
  const position = offset ?? 0;
  const key = sessionId + ':' + name;
  if (position !== 0) {
    const next = pending.get(key);
    if (!next || next.offset !== position || next.digest !== hash) {
      throw new Error('Start again at offset 0. The skill changed or a page was skipped.');
    }
  }
  const { text, end } = skillPage(source, Number(position));
  if (end < source.length) {
    if (pending.size >= 512 && !pending.has(key)) pending.delete(pending.keys().next().value!);
    pending.set(key, { digest: hash, offset: end });
    return { skill: name, text, nextOffset: end };
  }

  await appendSkillReceipt(sessionId, {
    name, worktree, result: 'read', reason: 'All pages returned', timestamp: new Date().toISOString(),
    sourceDigest: hash,
  });
  pending.delete(key);
  return { skill: name, text, nextOffset: null };
}

async function readReceipts(file: string): Promise<Receipt[]> {
  try {
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const offset = Math.max(0, size - MAX_RECEIPT_BYTES);
      const buffer = Buffer.alloc(size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      if (offset) lines.shift();
      return lines.slice(-61).flatMap(line => {
        try {
          const entry = JSON.parse(line);
          if (!entry || typeof entry.name !== 'string' || typeof entry.worktree !== 'string'
            || typeof entry.reason !== 'string' || typeof entry.timestamp !== 'string'
            || !['ran', 'blocked', 'failed', 'read', 'checkpoint'].includes(entry.result)) return [];
          const { name, worktree, reason, timestamp, result } = entry;
          const sourceDigest = typeof entry.sourceDigest === 'string' ? entry.sourceDigest : undefined;
          return [{ name, worktree, reason, timestamp, result, sourceDigest }];
        } catch { return []; }
      });
    } finally {
      await handle.close();
    }
  } catch { return []; }
}

export async function recordWorkflowCheckpoint(sessionId: string, workspace: string, skill: unknown) {
  const { name, worktree, hash } = await managedSkill(sessionId, workspace, skill);
  const receipts = await readReceipts(receiptPath('skill', sessionId));
  const fullRead = receipts.some(receipt => receipt.result === 'read' && receipt.name === name
    && receipt.sourceDigest === hash && sameWorkspaceIdentity(receipt.worktree, worktree));
  await appendSkillReceipt(sessionId, {
    name, worktree, result: 'checkpoint', timestamp: new Date().toISOString(),
    reason: fullRead ? 'Current skill returned before checkpoint' : 'No full read of current skill before checkpoint',
  });
  return fullRead;
}

function duplicateParagraphs(text: string): Set<string> {
  return new Set(text.split(/\r?\n\s*\r?\n/).map(paragraph => paragraph.replace(/\s+/g, ' ').trim())
    .filter(paragraph => paragraph.length >= 40));
}

export async function readWorkflowEvidence(
  session: Session,
  skipApp: boolean,
  snapshot?: { file: string; content: string },
) {
  const project = session.workspacePath!;
  const worktree = session.worktreePath ?? project;
  const provider = session.provider ?? '';
  const name = provider.startsWith('claude-code') ? 'CLAUDE.md' : 'AGENTS.md';
  const roots = [{ path: project, layer: 'Project' }];
  if (!sameWorkspaceIdentity(worktree, project)) roots.push({ path: worktree, layer: 'Worktree' });
  const layers = await Promise.all(roots.map(async ({ path, layer }) => {
    const file = join(path, name);
    const text = await readBoundedSource(file).catch(() => undefined);
    return { layer, file, text };
  }));
  if (snapshot) layers.push({ layer: 'Session snapshot', file: snapshot.file, text: snapshot.content });
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const layer of layers) {
    for (const section of duplicateParagraphs(layer.text ?? '')) {
      if (seen.has(section)) repeated.add(section);
      seen.add(section);
    }
  }
  const native = nativeProviders[provider];
  const hookInstalled = !!native && (await stat(join(worktree, '.codex', 'hooks', 'hook_receipt.py'))
    .catch(() => null))?.isFile();
  const [hookReceipts, skillReceipts] = await Promise.all([
    native && session.providerSessionId
      ? readReceipts(receiptPath('hook', native + '\0' + session.providerSessionId))
      : Promise.resolve([]),
    readReceipts(receiptPath('skill', session.id)),
  ]);
  return {
    addendumVersion: AGENT_ADDENDUM_VERSION,
    skipApp,
    skipProject: skipApp && provider === 'openai-codex',
    layers: layers.map(({ layer, file, text }) => ({ layer, file, found: text !== undefined })),
    duplicates: repeated.size,
    hookStatus: hookReceipts.length ? 'observed' : hookInstalled ? 'unobserved' : 'unavailable',
    hookReceipts,
    skillReceipts,
  };
}

export type WorkflowEvidence = Awaited<ReturnType<typeof readWorkflowEvidence>>;
