import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCodexBinaryPath } from '@nimbalyst/runtime/ai/server/protocols/codexAppServer/codexAppServerBinary';
import { resolvePackagedCodexBinaryPath } from '@nimbalyst/runtime/ai/server/providers/codex/codexBinaryPath';
import { WORK_SUMMARY_INSTRUCTIONS } from './sessionWorkSummary';

const schema = {
  type: 'object', additionalProperties: false,
  required: ['scope', 'remaining', 'attention', 'areas', 'requests'],
  properties: {
    scope: { type: 'string' }, remaining: { type: 'string' },
    attention: { type: 'string', enum: ['next', 'blocked', 'review', 'none', 'unknown'] },
    areas: { type: 'array', items: { type: 'string' } },
    requests: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['id', 'status', 'evidence'],
      properties: { id: { type: 'string' }, status: { type: 'string', enum: ['pending', 'resolved', 'superseded'] }, evidence: { type: 'string' } } } },
  },
};

export function workSummaryCodexArgs(directory: string, model?: string): string[] {
  const args = ['exec', '--json', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--cd', directory,
    '--color', 'never', '--output-schema', join(directory, 'schema.json'), '--output-last-message', join(directory, 'answer.json'),
    '-c', 'project_doc_max_bytes=0', '-c', 'web_search="disabled"', '-c', 'model_reasoning_effort="low"'];
  // Isolated text inference: no project, MCP servers, plugins or working-thread reuse.
  for (const feature of ['shell_tool', 'multi_agent', 'apps', 'plugins', 'skill_search', 'browser_use', 'computer_use', 'image_generation', 'memories', 'view_image', 'sleep_tool']) args.push('--disable', feature);
  if (model) args.push('--model', model);
  args.push('-');
  return args;
}

const checked = new Set<string>();
const children = new Set<ChildProcess>();
export function cancelWorkSummaryCompletions(): void {
  for (const child of children) child.kill();
}
export interface WorkSummaryTokenUsage { inputTokens: number; cachedInputTokens?: number; outputTokens: number }
export function readWorkSummaryUsage(line: string): WorkSummaryTokenUsage | undefined {
  try {
    const event = JSON.parse(line);
    const usage = event.type === 'turn.completed' ? event.usage : undefined;
    if (!usage || !Number.isSafeInteger(usage.input_tokens) || usage.input_tokens < 0 || !Number.isSafeInteger(usage.output_tokens) || usage.output_tokens < 0) return;
    return { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
      ...(Number.isSafeInteger(usage.cached_input_tokens) && usage.cached_input_tokens >= 0 ? { cachedInputTokens: usage.cached_input_tokens } : {}) };
  } catch { return; }
}
export async function completeWorkSummaryWithCodex(input: string, model?: string, onUsage?: (usage: WorkSummaryTokenUsage) => void): Promise<string> {
  if (Buffer.byteLength(input, 'utf8') > 20000) throw new Error('Summary input exceeds its budget.');
  const binary = resolveCodexBinaryPath(() => resolvePackagedCodexBinaryPath());
  if (!checked.has(binary)) {
    const { stdout } = await promisify(execFile)(binary, ['exec', '--help'], { timeout: 10000, maxBuffer: 32000 });
    if (!stdout.includes('--ignore-user-config') || !stdout.includes('--ephemeral')) throw new Error('The installed Codex needs ephemeral and isolated-config support for summaries.');
    checked.add(binary);
  }
  const directory = await mkdtemp(join(tmpdir(), 'marilyst-work-summary-'));
  try {
    await writeFile(join(directory, 'schema.json'), JSON.stringify(schema), { mode: 0o600 });
    await new Promise<void>((resolve, reject) => {
      const child = spawn(binary, workSummaryCodexArgs(directory, model), { cwd: directory, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      let pending = '';
      let oversized = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        for (const piece of chunk.split(/(?<=\n)/)) {
          if (!oversized) pending += piece;
          if (pending.length > 65536) { pending = ''; oversized = true; }
          if (piece.endsWith('\n')) {
            if (!oversized) { const usage = readWorkSummaryUsage(pending); if (usage) onUsage?.(usage); }
            pending = ''; oversized = false;
          }
        }
      });
      children.add(child);
      const timer = setTimeout(() => { child.kill(); reject(new Error('Summary timed out; retry from session details.')); }, 90000);
      // Drain diagnostics without retaining account-specific native error text.
      child.stderr.resume();
      child.once('error', () => { children.delete(child); clearTimeout(timer); reject(new Error('Could not start the isolated summary process.')); });
      child.once('exit', code => { children.delete(child); clearTimeout(timer); code === 0 ? resolve() : reject(new Error('Native summary failed. Check Codex sign-in and retry.')); });
      child.stdin.on('error', () => {});
      child.stdin.end(`${WORK_SUMMARY_INSTRUCTIONS}\n\nEvidence JSON:\n${input}`);
    });
    const result = await readFile(join(directory, 'answer.json'), 'utf8');
    if (Buffer.byteLength(result, 'utf8') > 24000) throw new Error('Generated summary exceeded its output budget.');
    return result;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
