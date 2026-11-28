import { ProviderFactory } from '@nimbalyst/runtime/ai/server/ProviderFactory';
import type { AIProviderType } from '@nimbalyst/runtime/ai/server/types';
import { getDatabase } from '../database/initialize';
import { readClaudeCliContextEvidence, type ClaudeCliRequestEvidence } from './claudeCliContextEvidence';
import {
  asObject, isLiveContextCapable, list, readRecordedClaudeContextReport, str, strings, summarizeClaudeContextReport,
  type ClaudeContextReport,
} from './claudeContextReport';

export type { ClaudeContextReport } from './claudeContextReport';

/**
 * Context inspection for Claude Agent and Claude terminal sessions.
 *
 * Read from rows the session already persisted in `ai_agent_messages` (the
 * last turn's request options, the SDK init frame, a manual `/context` report),
 * the breakdown recorded after the last turn, and, when the SDK subprocess is
 * alive, a live `getContextUsage()` call. Claude's built-in system prompt text
 * itself is never available; only its section names and token counts are.
 */

/** Per-text cap for IPC. */
const TEXT_LIMIT = 64 * 1024;

type Row = { content: string; metadata?: unknown; created_at?: unknown };

export interface ClaudeLastRequest {
  recordedAt: string | null;
  model: string | null;
  permissionMode: string | null;
  thinking: unknown;
  effort: string | null;
  resumed: boolean;
  settingSources: string[];
  mcpServers: string[];
  allowedTools: string[];
  disallowedTools: string[];
  systemPromptPreset: string | null;
  attachments: string[];
  /** Only when raw text is requested (the local inspector). */
  systemPromptAppend?: string | null;
  customSystemPrompt?: string | null;
  prompt?: string | null;
}

export interface ClaudeStartup {
  recordedAt: string | null;
  model: string | null;
  permissionMode: string | null;
  outputStyle: string | null;
  apiKeySource: string | null;
  claudeCodeVersion: string | null;
  cwd: string | null;
  tools: string[];
  mcpServers: { name: string; status: string | null }[];
  agents: string[];
  plugins: { name: string; path: string | null }[];
  skills: string[];
  slashCommands: string[];
}

export interface ClaudeContextInspection {
  lastRequest: ClaudeLastRequest | null;
  startup: ClaudeStartup | null;
  contextReport: ClaudeContextReport | null;
  liveError: string | null;
  cli?: ReturnType<typeof readClaudeCliContextEvidence>;
  responseModel: string | null;
}

const capText = (text: unknown): string | null => {
  if (typeof text !== 'string') return null;
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n\n[truncated ${text.length - TEXT_LIMIT} characters]` : text;
};
const timestamp = (value: unknown): string | null => {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

/** The `input` row logged by the Claude turn prologue: prompt as sent plus the query options. */
export function summarizeClaudeRequest(row: Row, includeText: boolean): ClaudeLastRequest | null {
  const parsed = asObject(row.content);
  if (!parsed || typeof parsed.prompt !== 'string') return null;
  const options = asObject(parsed.options) ?? {};
  const systemPrompt = options.systemPrompt;
  const systemObject = asObject(systemPrompt);
  const metadata = asObject(row.metadata) ?? {};
  const request: ClaudeLastRequest = {
    recordedAt: timestamp(row.created_at),
    model: str(options.model),
    permissionMode: str(options.permissionMode),
    thinking: options.thinking ?? null,
    effort: str(options.effort),
    resumed: typeof options.resume === 'string' && options.resume.length > 0,
    settingSources: strings(options.settingSources),
    mcpServers: strings(options.mcpServers),
    allowedTools: strings(options.allowedTools),
    disallowedTools: strings(options.disallowedTools),
    systemPromptPreset: systemObject?.type === 'preset' ? str(systemObject.preset) : null,
    attachments: list(metadata.attachments).map(a => str(a.filename) ?? str(a.filepath)?.split(/[\\/]/).pop() ?? 'attachment'),
  };
  if (includeText) {
    request.systemPromptAppend = capText(systemObject?.append);
    request.customSystemPrompt = capText(typeof systemPrompt === 'string' ? systemPrompt : systemObject?.prompt);
    request.prompt = capText(parsed.prompt);
  }
  return request;
}

/** The SDK `system`/`init` frame: what the CLI actually loaded at startup. */
export function summarizeClaudeStartup(row: Row): ClaudeStartup | null {
  const frame = asObject(row.content);
  if (!frame || frame.type !== 'system' || frame.subtype !== 'init') return null;
  return {
    recordedAt: timestamp(row.created_at),
    model: str(frame.model),
    permissionMode: str(frame.permissionMode),
    outputStyle: str(frame.output_style),
    apiKeySource: str(frame.apiKeySource),
    claudeCodeVersion: str(frame.claude_code_version),
    cwd: str(frame.cwd),
    tools: strings(frame.tools),
    mcpServers: list(frame.mcp_servers).map(s => ({ name: str(s.name) ?? 'unknown', status: str(s.status) })),
    agents: strings(frame.agents),
    plugins: list(frame.plugins).map(p => ({ name: str(p.name) ?? 'unknown', path: str(p.path) })),
    skills: strings(frame.skills),
    slashCommands: strings(frame.slash_commands),
  };
}

async function latestRow(sessionId: string, where: string): Promise<Row | null> {
  const { rows } = await getDatabase().query<Row>(
    `SELECT content, metadata, created_at FROM ai_agent_messages
     WHERE session_id = $1 AND ${where}
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [sessionId],
  );
  return rows[0] ?? null;
}

export async function readClaudeContextInspection(
  session: { id: string; provider?: string },
  { includeText = false, live = true, redactPaths = false }: { includeText?: boolean; live?: boolean; redactPaths?: boolean } = {},
): Promise<ClaudeContextInspection> {
  const isCli = session.provider === 'claude-code-cli';
  const cli = isCli ? readClaudeCliContextEvidence(session.id, includeText) : undefined;
  const [requestRow, startupRow, reportRow, cliRequestRow, responseRow] = await Promise.all([
    // Hidden turns are auto-commands like /context; they are not the user's request.
    isCli ? null : latestRow(session.id, `direction = 'input' AND content LIKE '{"prompt":%' AND (hidden = FALSE OR hidden IS NULL)`),
    latestRow(session.id, `direction = 'output' AND content LIKE '{"type":"system"%' AND content LIKE '%"subtype":"init"%'`),
    latestRow(session.id, `direction = 'output' AND content LIKE '%"context_usage":{%'`),
    cli && !cli.request ? latestRow(session.id, `direction = 'output' AND content LIKE '{"type":"nimbalyst_claude_cli_request",%'`) : null,
    latestRow(session.id, `direction = 'output' AND content LIKE '{"type":"assistant",%' AND (hidden = FALSE OR hidden IS NULL)`),
  ]);

  let contextReport: ClaudeContextReport | null = null;
  let liveError: string | null = null;
  // Cache lookup only; never creates a provider for an idle session.
  const provider = live && session.provider ? ProviderFactory.getProvider(session.provider as AIProviderType, session.id) : null;
  if (isLiveContextCapable(provider)) {
    try {
      contextReport = summarizeClaudeContextReport(await provider.getLiveContextUsage(), 'live', new Date().toISOString());
    } catch (error) {
      liveError = error instanceof Error ? error.message : String(error);
    }
  }
  if (!contextReport) contextReport = await readRecordedClaudeContextReport(session.id);
  if (!contextReport && reportRow) {
    contextReport = summarizeClaudeContextReport(asObject(reportRow.content)?.context_usage, 'stored', timestamp(reportRow.created_at));
  }

  const startup = startupRow ? summarizeClaudeStartup(startupRow) : null;
  if (startup && redactPaths) {
    startup.cwd = null;
    startup.plugins = startup.plugins.map(plugin => ({ ...plugin, path: null }));
  }
  if (contextReport && redactPaths) {
    contextReport.memoryFiles = contextReport.memoryFiles.map(file => ({ ...file, path: file.path.split(/[\\/]/).pop() ?? '' }));
  }
  if (cliRequestRow && cli) {
    const stored = asObject(cliRequestRow.content);
    if (stored) {
      cli.request = {
        recordedAt: str(stored.recordedAt) ?? '',
        model: str(stored.model),
        effort: str(stored.effort),
        blocks: list(stored.blocks).flatMap(({ role, bytes }) =>
          (role === 'system' || role === 'user') && typeof bytes === 'number' ? [{ role, bytes }] : []),
      } satisfies ClaudeCliRequestEvidence;
    }
  }
  return {
    lastRequest: requestRow ? summarizeClaudeRequest(requestRow, includeText) : null,
    startup,
    contextReport,
    liveError,
    cli,
    responseModel: str(asObject(asObject(responseRow?.content)?.message)?.model),
  };
}
