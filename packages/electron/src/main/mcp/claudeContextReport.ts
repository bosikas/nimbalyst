import { app } from 'electron';
import { mkdir, readFile, rename, writeFile } from 'fs/promises';
import { join } from 'path';

/**
 * Claude's structured context breakdown (`getContextUsage()` or `/context`),
 * normalized to what the context inspector shows, plus the per-session file
 * that keeps the latest one across restarts.
 *
 * Kept free of provider and database imports: the turn-end hook in
 * MessageStreamingHandler imports it.
 */

type Named = { name: string; tokens: number };

export interface ClaudeContextReport {
  source: 'live' | 'stored';
  recordedAt: string | null;
  model: string | null;
  totalTokens: number | null;
  maxTokens: number | null;
  autoCompactThreshold: number | null;
  categories: (Named & { kind: string | null })[];
  memoryFiles: { path: string; type: string | null; tokens: number }[];
  systemPromptSections: Named[];
  systemTools: Named[];
  mcpTools: (Named & { serverName: string | null; isLoaded: boolean | null })[];
  mcpInstructions: { serverName: string; tokens: number }[];
  deferredBuiltinTools: (Named & { isLoaded: boolean | null })[];
  agents: { agentType: string; source: string | null; path: string | null; tokens: number }[];
  skills: { name: string; source: string | null; path: string | null; tokens: number }[];
  messageBreakdown: Record<string, number> | null;
  apiUsage: { inputTokens: number; outputTokens: number; cacheCreationInputTokens: number; cacheReadInputTokens: number } | null;
}

export const asObject = (value: unknown): Record<string, any> | null => {
  if (typeof value === 'string') {
    try { return asObject(JSON.parse(value)); } catch { return null; }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
};
export const str = (value: unknown): string | null => typeof value === 'string' && value ? value : null;
export const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
export const list = (value: unknown): Record<string, any>[] => Array.isArray(value) ? value.filter(v => v && typeof v === 'object') : [];
const num = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const numOrNull = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bool = (value: unknown): boolean | null => typeof value === 'boolean' ? value : null;
const byTokens = <T extends { tokens: number }>(items: T[]) => items.sort((a, b) => b.tokens - a.tokens);

/** Normalize the SDK's breakdown, keeping what the dialog shows (drops e.g. `gridRows`). */
export function summarizeClaudeContextReport(usage: unknown, source: 'live' | 'stored', recordedAt: string | null): ClaudeContextReport | null {
  const report = asObject(usage);
  if (!report || !Array.isArray(report.categories)) return null;
  const named = (items: unknown): Named[] => byTokens(list(items).map(i => ({ name: str(i.name) ?? 'unknown', tokens: num(i.tokens) })));
  const breakdown = asObject(report.messageBreakdown);
  const apiUsage = asObject(report.apiUsage);
  return {
    source,
    recordedAt,
    model: str(report.model),
    totalTokens: numOrNull(report.totalTokens),
    maxTokens: numOrNull(report.maxTokens),
    autoCompactThreshold: report.isAutoCompactEnabled === false ? null : numOrNull(report.autoCompactThreshold),
    categories: list(report.categories).map(c => ({ name: str(c.name) ?? 'unknown', tokens: num(c.tokens), kind: str(c.kind) })),
    memoryFiles: list(report.memoryFiles).map(f => ({ path: str(f.path) ?? 'unknown', type: str(f.type), tokens: num(f.tokens) })),
    systemPromptSections: named(report.systemPromptSections),
    systemTools: named(report.systemTools),
    mcpTools: byTokens(list(report.mcpTools).map(t => ({ name: str(t.name) ?? 'unknown', serverName: str(t.serverName), tokens: num(t.tokens), isLoaded: bool(t.isLoaded) }))),
    mcpInstructions: byTokens(list(report.mcpInstructions).map(i => ({ serverName: str(i.serverName) ?? 'unknown', tokens: num(i.tokens) }))),
    deferredBuiltinTools: byTokens(list(report.deferredBuiltinTools).map(t => ({ name: str(t.name) ?? 'unknown', tokens: num(t.tokens), isLoaded: bool(t.isLoaded) }))),
    agents: byTokens(list(report.agents).map(a => ({ agentType: str(a.agentType) ?? 'unknown', source: str(a.source), path: str(a.path), tokens: num(a.tokens) }))),
    skills: byTokens(list(asObject(report.skills)?.skillFrontmatter).map(s => ({ name: str(s.name) ?? 'unknown', source: str(s.source), path: str(s.path), tokens: num(s.tokens) }))),
    messageBreakdown: breakdown ? Object.fromEntries(Object.entries(breakdown).filter(([, v]) => typeof v === 'number')) as Record<string, number> : null,
    apiUsage: apiUsage ? {
      inputTokens: num(apiUsage.input_tokens),
      outputTokens: num(apiUsage.output_tokens),
      cacheCreationInputTokens: num(apiUsage.cache_creation_input_tokens),
      cacheReadInputTokens: num(apiUsage.cache_read_input_tokens),
    } : null,
  };
}

export type LiveContextCapable = { getLiveContextUsage(): Promise<unknown | null> };
export const isLiveContextCapable = (value: unknown): value is LiveContextCapable =>
  !!value && typeof (value as LiveContextCapable).getLiveContextUsage === 'function';

/**
 * The latest per-turn breakdown lives in one overwritten file per session under
 * app data, not in `ai_agent_messages`: it is a derived diagnostic, so it stays
 * out of the transcript, sync and retention, and never grows with turn count.
 */
const reportFile = (sessionId: string) => {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('Invalid session id for context report.');
  return join(app.getPath('userData'), 'context-reports', `${sessionId}.json`);
};

/** Record the live breakdown after a Claude turn. Best effort; never throws. */
export async function captureClaudeContextReport(sessionId: string, provider: unknown): Promise<boolean> {
  try {
    if (!isLiveContextCapable(provider)) return false;
    const report = summarizeClaudeContextReport(await provider.getLiveContextUsage(), 'stored', new Date().toISOString());
    if (!report) return false;
    const file = reportFile(sessionId);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(report), 'utf8');
    await rename(`${file}.tmp`, file);
    return true;
  } catch (error) {
    console.warn('[ContextInspection] Could not record Claude context report:', error instanceof Error ? error.message : error);
    return false;
  }
}

export async function readRecordedClaudeContextReport(sessionId: string): Promise<ClaudeContextReport | null> {
  try {
    const report = JSON.parse(await readFile(reportFile(sessionId), 'utf8'));
    return report && Array.isArray(report.categories) ? { ...report, source: 'stored' } : null;
  } catch {
    return null;
  }
}
