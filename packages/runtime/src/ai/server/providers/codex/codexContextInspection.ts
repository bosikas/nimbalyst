import type { ProtocolMessage } from '../../protocols/ProtocolInterface';
import type { JsonRpcClient } from '../../protocols/codexAppServer/jsonRpcClient';
import type { PreparedContextRequest } from '../preparedContextInspection';
import { capRecordedStartupText } from './codexRecordedStartup';

const latest = new Map<string, { snapshot: PreparedContextRequest; guidance?: string }>();
export function measureCodexContext(guidance: string, delivery: Pick<ProtocolMessage, 'content' | 'toolOutputs'>, configuredMcpServers: number, attachments: number): PreparedContextRequest {
  return {
    measuredAt: Date.now(),
    scope: 'Last Nimbalyst-prepared Codex request, before native processing; UTF-8 text bytes, not tokens or full thread size.',
    categories: [
      { name: 'Nimbalyst guidance', bytes: Buffer.byteLength(guidance, 'utf8'), reason: 'Prepared for the native developer-instruction field. An attached thread can retain earlier guidance.' },
      { name: 'User input and document additions', bytes: Buffer.byteLength(delivery.content, 'utf8'), reason: 'Current human or unknown-provenance input, selected document context and attachment hints.' },
      { name: 'Coordination tool context', bytes: (delivery.toolOutputs ?? []).reduce((n, t) => n + Buffer.byteLength(t.output, 'utf8'), 0), reason: 'Verified machine messages, bounded with full-output links; reports may be transient, active instructions retained.' },
    ],
    configuredMcpServers, attachments,
    nativeContext: 'Opaque or unavailable: native system instructions, loaded tool schemas, skill catalog, prior history/compaction state, image/document encoding and native categorization. These byte rows do not partition native token usage.',
  };
}
export function recordCodexContext(sessionId: string, snapshot: PreparedContextRequest, guidance?: string): void {
  const preview = guidance ? capRecordedStartupText(guidance, 16 * 1024) : undefined;
  latest.delete(sessionId);
  latest.set(sessionId, { snapshot, guidance: preview && (preview.text + (preview.truncated ? '\n[Preview truncated]' : '')) });
  // Diagnostic data is best-effort; bound app memory across many completed sessions.
  if (latest.size > 500) latest.delete(latest.keys().next().value!);
}
export function readCodexContext(sessionId: string): PreparedContextRequest | null {
  return latest.get(sessionId)?.snapshot ?? null;
}

export function readCodexPreparedGuidance(sessionId: string): string | undefined {
  return latest.get(sessionId)?.guidance;
}
export interface CodexContextEvidence {
  compactions: Array<{ id: string; startedAt: number; completedAt: number | null; beforeTokens: number | null; afterTokens: number | null }>;
  observedTools: Array<{ server: string; tool: string; calls: number; lastObservedAt: number }>;
  omittedToolCalls: number;
}
type EvidenceState = CodexContextEvidence & { lastTokens: number | null; seenCalls: Set<string> };
const evidenceBySession = new Map<string, EvidenceState>();

function evidenceFor(sessionId: string): EvidenceState {
  let state = evidenceBySession.get(sessionId);
  if (!state) {
    state = { compactions: [], observedTools: [], omittedToolCalls: 0, lastTokens: null, seenCalls: new Set() };
    evidenceBySession.set(sessionId, state);
    if (evidenceBySession.size > 500) evidenceBySession.delete(evidenceBySession.keys().next().value!);
  }
  return state;
}

export function readCodexContextEvidence(sessionId: string): CodexContextEvidence {
  const state = evidenceBySession.get(sessionId);
  return {
    compactions: state?.compactions.map(c => ({ ...c })).reverse() ?? [],
    observedTools: state?.observedTools.map(t => ({ ...t })).sort((a, b) => b.lastObservedAt - a.lastObservedAt) ?? [],
    omittedToolCalls: state?.omittedToolCalls ?? 0,
  };
}

/** Observe native notifications even when compaction runs outside sendMessage.
 * Keep only bounded metadata, never summaries, arguments, results or transcripts.
 * A usage sample following compaction is evidence, not an isolated savings claim.
 */
export function observeCodexContextNotifications(client: Pick<JsonRpcClient, 'onNotification'>, sessionId: string | undefined, threadId: () => string): void {
  if (!sessionId) return;
  client.onNotification((method, value) => {
    const params = value as { threadId?: string; item?: { id?: string; type?: string; server?: string; tool?: string }; tokenUsage?: { last?: { totalTokens?: number; total_tokens?: number } } } | null;
    if (!threadId() || params?.threadId !== threadId()) return;
    const state = evidenceFor(sessionId);
    const item = params.item;
    if (method === 'thread/tokenUsage/updated') {
      const tokens = params.tokenUsage?.last?.totalTokens ?? params.tokenUsage?.last?.total_tokens;
      if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return;
      state.lastTokens = tokens;
      const pending = state.compactions.at(-1);
      if (pending && pending.completedAt !== null && pending.afterTokens === null) pending.afterTokens = tokens;
    } else if (item?.type === 'contextCompaction' && item.id && (method === 'item/started' || method === 'item/completed')) {
      let entry = state.compactions.find(c => c.id === item.id);
      if (!entry) {
        entry = { id: item.id, startedAt: Date.now(), completedAt: null, beforeTokens: method === 'item/started' ? state.lastTokens : null, afterTokens: null };
        state.compactions.push(entry);
        if (state.compactions.length > 20) state.compactions.shift();
      }
      if (method === 'item/completed') entry.completedAt = Date.now();
    } else if (method === 'item/started' && item?.type === 'mcpToolCall' && item.id && item.server && item.tool && !state.seenCalls.has(item.id)) {
      state.seenCalls.add(item.id);
      if (state.seenCalls.size > 2000) state.seenCalls.delete(state.seenCalls.values().next().value!);
      let entry = state.observedTools.find(t => t.server === item.server && t.tool === item.tool);
      if (!entry && state.observedTools.length < 200) {
        entry = { server: item.server, tool: item.tool, calls: 0, lastObservedAt: 0 };
        state.observedTools.push(entry);
      }
      if (entry) { entry.calls++; entry.lastObservedAt = Date.now(); }
      else state.omittedToolCalls++;
    }
  });
}
