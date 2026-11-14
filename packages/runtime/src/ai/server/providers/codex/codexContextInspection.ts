import type { ProtocolMessage } from '../../protocols/ProtocolInterface';

export interface CodexContextInspection {
  measuredAt: number;
  scope: string;
  categories: Array<{ name: string; bytes: number; reason: string }>;
  configuredMcpServers: number;
  attachments: number;
  nativeContext: string;
}

/** Metadata only; never keep an extra copy of prompts, transcripts or credentials. */
const latest = new Map<string, CodexContextInspection>();
export function measureCodexContext(guidance: string, delivery: Pick<ProtocolMessage, 'content' | 'toolOutputs'>, configuredMcpServers: number, attachments: number): CodexContextInspection {
  return {
    measuredAt: Date.now(),
    scope: 'Last Nimbalyst-prepared Codex request, before native processing; UTF-8 text bytes, not tokens or full thread size.',
    categories: [
      { name: 'Nimbalyst guidance', bytes: Buffer.byteLength(guidance, 'utf8'), reason: 'Host integration rules supplied as developer instructions when starting or resuming the thread; not necessarily resent on a reused thread.' },
      { name: 'User input and document additions', bytes: Buffer.byteLength(delivery.content, 'utf8'), reason: 'Current human or unknown-provenance input, selected document context and attachment hints.' },
      { name: 'Coordination tool context', bytes: (delivery.toolOutputs ?? []).reduce((n, t) => n + Buffer.byteLength(t.output, 'utf8'), 0), reason: 'Verified machine messages, bounded with full-output links; reports may be transient, active instructions retained.' },
    ],
    configuredMcpServers, attachments,
    nativeContext: 'Opaque or unavailable: native system instructions, loaded tool schemas, skill catalog, prior history/compaction state, image/document encoding and native categorization. These byte rows do not partition native token usage.',
  };
}
export function recordCodexContext(sessionId: string, snapshot: CodexContextInspection): void {
  latest.delete(sessionId);
  latest.set(sessionId, snapshot);
  // Diagnostic data is best-effort; bound app memory across many completed sessions.
  if (latest.size > 500) latest.delete(latest.keys().next().value!);
}
export function readCodexContext(sessionId: string): CodexContextInspection | null {
  return latest.get(sessionId) ?? null;
}
