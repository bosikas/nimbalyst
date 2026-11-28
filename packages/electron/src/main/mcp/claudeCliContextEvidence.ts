import { AgentMessagesRepository } from '@nimbalyst/runtime/storage/repositories/AgentMessagesRepository';
import { capRecordedStartupText } from '@nimbalyst/runtime/ai/server/providers/codex/codexRecordedStartup';

interface TextBlock {
  role: 'system' | 'user';
  bytes: number;
  text?: string;
  truncated?: boolean;
}

export interface ClaudeCliRequestEvidence {
  recordedAt: string;
  model: string | null;
  effort: string | null;
  blocks: TextBlock[];
}

interface PreparedLaunch {
  recordedAt: string;
  model: string | null;
  effort: string | null;
  resumed: boolean;
  enterpriseMcpLockdown: boolean;
  append?: string;
}

const launches = new Map<string, PreparedLaunch>();
const requests = new Map<string, ClaudeCliRequestEvidence>();
const maxSessions = 32;
const asObject = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : undefined;
const setting = (value: unknown) => typeof value === 'string' && /^[\w.:+\-\[\]]{1,120}$/.test(value) ? value : null;

function remember<T>(map: Map<string, T>, sessionId: string, value: T) {
  map.delete(sessionId);
  map.set(sessionId, value);
  if (map.size > maxSessions) map.delete(map.keys().next().value!);
}

export function recordPreparedClaudeCliLaunch(sessionId: string, args: string[], effort: unknown, enterpriseMcpLockdown: boolean) {
  const atFlag = (flag: string) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
  remember(launches, sessionId, {
    recordedAt: new Date().toISOString(),
    model: setting(atFlag('--model')),
    effort: setting(effort),
    resumed: args.includes('--resume'),
    enterpriseMcpLockdown,
    append: atFlag('--append-system-prompt'),
  });
}

/** Only text blocks from the actual request. Tool I/O, headers and other body fields stay out. */
export function summarizeObservedClaudeCliRequest(body: Record<string, unknown>, recordedAt: string): ClaudeCliRequestEvidence {
  const blocks: TextBlock[] = [];
  const add = (role: TextBlock['role'], content: unknown, remaining: number, limit: number) => {
    for (const block of Array.isArray(content) ? content : [content]) {
      if (blocks.length >= limit) break;
      const entry = asObject(block);
      const text = typeof block === 'string' ? block : entry?.type === 'text' ? entry.text : undefined;
      if (typeof text !== 'string' || !text) continue;
      const preview = capRecordedStartupText(text, remaining);
      remaining -= Buffer.byteLength(preview.text);
      blocks.push({ role, bytes: Buffer.byteLength(text), text: preview.text, truncated: preview.truncated });
    }
  };
  add('system', body.system, 24 * 1024, 16);
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const users = messages.filter(message => asObject(message)?.role === 'user');
  // Keep the opening native context and latest input, including on resume.
  if (users.length > 1) add('user', asObject(users[0])?.content, 4 * 1024, blocks.length + 4);
  add('user', asObject(users.at(-1))?.content, 4 * 1024, blocks.length + 4);
  return { recordedAt, model: setting(body.model), effort: setting(asObject(body.output_config)?.effort), blocks };
}

export function recordObservedClaudeCliRequest(sessionId: string, body: Record<string, unknown>): void {
  const request = summarizeObservedClaudeCliRequest(body, new Date().toISOString());
  remember(requests, sessionId, request);
  // The existing session ledger can sync. Persist only bounded counts and settings there.
  void AgentMessagesRepository.create({
    sessionId,
    source: 'claude-code',
    direction: 'output',
    content: JSON.stringify({ type: 'nimbalyst_claude_cli_request', ...withoutText(request) }),
    hidden: true,
    searchable: false,
    messageKind: 'meta',
  }).catch(() => {});
}

function withoutText(request: ClaudeCliRequestEvidence): ClaudeCliRequestEvidence {
  return { ...request, blocks: request.blocks.map(({ role, bytes }) => ({ role, bytes })) };
}

export function readClaudeCliContextEvidence(sessionId: string, includeText: boolean) {
  const launch = launches.get(sessionId);
  const request = requests.get(sessionId);
  return {
    launch: launch ? { ...launch, append: includeText ? launch.append : undefined } : null,
    request: request ? (includeText ? request : withoutText(request)) : null,
  };
}
