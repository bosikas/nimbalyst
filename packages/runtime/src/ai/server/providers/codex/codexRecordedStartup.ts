// Pure parser for recorded Codex startup: no node:* imports, so the renderer,
// mobile and the offline script can share it. File access lives in Electron main
// (packages/electron/src/main/mcp/codexRolloutStartup.ts). The offline script
// imports this file through Node type stripping: keep types erasable.

export interface CodexRecordedMessage {
  line: number;
  role: string;
  kinds: string[];
  /** UTF-8 bytes of the recorded text parts; never tokens. */
  bytes: number;
  /** Fingerprint of the full raw content (boundaries and attachments included), when a hasher is supplied. */
  sha256?: string;
  text: string;
  textTruncated: boolean;
}

export interface CodexAuditSnapshot {
  line: number;
  name: string;
  bytes: number;
  sha256?: string;
  /** The snapshot text is identical to this recorded message: one instruction body, not two. */
  sameTextAsMessageLine?: number;
  text?: string;
  textTruncated?: boolean;
}

export interface CodexRecordedStartup {
  provider?: 'mistral-vibe';
  source?: string;
  session: { id?: string; role: 'agent' | 'automatic-approval-reviewer'; model?: string; effort?: string; runtimeVersion?: string; approvalsReviewer?: string };
  /** Recorded in the rollout log. Not proof of what was transmitted to the model. */
  messages: CodexRecordedMessage[];
  recordedMessageBytes: number;
  snapshots: CodexAuditSnapshot[];
  toolRecords: Array<{ line: number; bytes: number; definitions: number }>;
  repeatedMessages: Array<{ lines: number[]; bytesPerMessage: number }>;
  /** Source line of the first opening input; null means the capture may be incomplete. */
  boundaryLine: number | null;
}

export type CodexRolloutRecord = { type?: string; payload?: any };

export interface InspectOptions {
  /** Cap returned text per message; byte counts always describe the full record. */
  maxTextBytes?: number;
  /** Optional digest for reported fingerprints. Comparisons use exact content, not this digest. */
  fingerprint?: (text: string) => string;
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const kindsOf = (payload: any): string[] => payload?.internal_chat_message_metadata_passthrough?.content_item_kinds ?? [];

/** The opening task input, or a tool-delivered machine input. AGENTS/environment user-role messages are not. */
export const isCodexOpeningInput = (record: CodexRolloutRecord) => record.type === 'response_item'
  && (kindsOf(record.payload).includes('user.text') || record.payload?.type === 'function_call_output');

export function capRecordedStartupText(text: string, maxBytes: number): { text: string; truncated: boolean } {
  if (bytes(text) <= maxBytes) return { text, truncated: false };
  let used = 0;
  let end = 0;
  for (const character of text) {
    const size = bytes(character);
    if (used + size > maxBytes) break;
    used += size;
    end += character.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/** Recorded startup evidence, not a reconstruction of the outbound API request. */
export function inspectCodexStartupRecords(records: Iterable<CodexRolloutRecord>, options: InspectOptions = {}): CodexRecordedStartup {
  const maxTextBytes = options.maxTextBytes ?? Number.POSITIVE_INFINITY;
  const digest = options.fingerprint;
  const report: CodexRecordedStartup = { session: { role: 'agent' }, messages: [], recordedMessageBytes: 0, snapshots: [], toolRecords: [], repeatedMessages: [], boundaryLine: null };
  // Exact comparison keys stay local; only bounded metadata is returned.
  const contentKey = new Map<CodexRecordedMessage, string>();
  const singleText = new Map<CodexRecordedMessage, string>();
  const snapshotText = new Map<CodexAuditSnapshot, string>();
  let line = 0;
  for (const record of records) {
    line++;
    const payload = record.payload ?? {};
    if (record.type === 'session_meta') {
      report.session.id = payload.id ?? payload.session_id;
      report.session.runtimeVersion = payload.cli_version;
      if (payload.source?.subagent?.other === 'guardian') report.session.role = 'automatic-approval-reviewer';
      const text = payload.base_instructions?.text;
      if (typeof text === 'string') {
        const snapshot: CodexAuditSnapshot = { line, name: 'Session metadata: base instructions', bytes: bytes(text), sha256: digest?.(text) };
        snapshotText.set(snapshot, text);
        report.snapshots.push(snapshot);
      }
    } else if (record.type === 'world_state') {
      report.snapshots.push({ line, name: 'Native state snapshot', bytes: bytes(JSON.stringify(payload)) });
      const text = payload.state?.agents_md?.text;
      if (typeof text === 'string') {
        const snapshot: CodexAuditSnapshot = { line, name: 'Native state: AGENTS.md text', bytes: bytes(text), sha256: digest?.(text) };
        snapshotText.set(snapshot, text);
        report.snapshots.push(snapshot);
      }
    } else if (record.type === 'turn_context') {
      if (typeof payload.model === 'string') report.session.model = payload.model;
      if (typeof payload.effort === 'string') report.session.effort = payload.effort;
      report.session.approvalsReviewer = payload.approvals_reviewer;
      report.snapshots.push({ line, name: 'Turn settings snapshot', bytes: bytes(JSON.stringify(payload)) });
    } else if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
      report.snapshots.push({ line, name: 'Thread settings snapshot', bytes: bytes(JSON.stringify(payload)) });
    } else if (record.type === 'response_item' && payload.type === 'additional_tools') {
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      report.toolRecords.push({ line, bytes: bytes(JSON.stringify(tools)), definitions: tools.length });
    } else if (record.type === 'response_item' && (payload.type === 'message' || payload.type === 'function_call_output')) {
      const isOutput = payload.type === 'function_call_output';
      const textParts: string[] = isOutput
        ? [typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? '')]
        : (Array.isArray(payload.content) ? payload.content : []).filter((item: any) => typeof item?.text === 'string').map((item: any) => item.text);
      // Display separators are not recorded text bytes. Key on the raw content so
      // content boundaries and non-text attachments stay distinct.
      const raw = JSON.stringify(isOutput ? payload.output ?? null : payload.content ?? []);
      const capped = capRecordedStartupText(textParts.join('\n'), maxTextBytes);
      const entry: CodexRecordedMessage = {
        line,
        role: payload.role ?? 'tool',
        kinds: kindsOf(payload),
        bytes: textParts.reduce((sum, part) => sum + bytes(part), 0),
        sha256: digest?.(raw),
        text: capped.text,
        textTruncated: capped.truncated,
      };
      contentKey.set(entry, raw);
      if (textParts.length === 1) singleText.set(entry, textParts[0]);
      report.messages.push(entry);
      report.recordedMessageBytes += entry.bytes;
      if (isCodexOpeningInput(record)) {
        report.boundaryLine = line;
        break;
      }
    }
  }
  for (const [snapshot, text] of snapshotText) {
    const match = report.messages.find(message => singleText.get(message) === text);
    if (match) snapshot.sameTextAsMessageLine = match.line;
    else {
      const preview = capRecordedStartupText(text, maxTextBytes);
      snapshot.text = preview.text;
      snapshot.textTruncated = preview.truncated;
    }
  }
  const groups = new Map<string, CodexRecordedMessage[]>();
  for (const entry of report.messages) {
    // Roles and provenance remain distinct even when text happens to match.
    const key = JSON.stringify([entry.role, entry.kinds, contentKey.get(entry)]);
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  report.repeatedMessages = [...groups.values()].filter(group => group.length > 1).map(group => ({ lines: group.map(entry => entry.line), bytesPerMessage: group[0].bytes }));
  return report;
}

export const MAX_STARTUP_PREFIX_BYTES = 4_000_000;
const READ_CHUNK_BYTES = 64 * 1024;

/**
 * Assembles rollout records from raw byte chunks up to and including the
 * opening input, with memory bounded by the cap rather than by line length.
 * Callers read at most `wanted` bytes per step, so no more than cap + 1 bytes
 * are ever read. A prefix longer than the cap, invalid UTF-8 or invalid JSON
 * throws; nothing is silently truncated. A final line without a newline is a
 * record. EOF without an opening input leaves the report boundary null.
 */
export class CodexStartupPrefixCollector {
  readonly records: CodexRolloutRecord[] = [];
  private consumed = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private lineNumber = 0;
  private done = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true });
  private readonly maxBytes: number;

  // No parameter properties: the offline script loads this file with Node type stripping.
  constructor(maxBytes = MAX_STARTUP_PREFIX_BYTES) {
    this.maxBytes = maxBytes;
  }

  /** Bytes to read next; 0 once the opening input has been collected. */
  get wanted(): number {
    return this.done ? 0 : Math.max(0, Math.min(READ_CHUNK_BYTES, this.maxBytes + 1 - this.consumed));
  }

  push(chunk: Uint8Array): void {
    if (this.done) return;
    const start = this.consumed;
    this.consumed += chunk.length;
    let from = 0;
    for (let index = chunk.indexOf(0x0a); index !== -1 && !this.done; index = chunk.indexOf(0x0a, from)) {
      if (start + index + 1 > this.maxBytes) this.overflow();
      this.pending.push(chunk.subarray(from, index));
      this.pendingBytes += index - from;
      this.takeLine();
      from = index + 1;
    }
    if (this.done) return;
    if (this.consumed > this.maxBytes) this.overflow();
    // Copy: callers may reuse their read buffer.
    this.pending.push(chunk.slice(from));
    this.pendingBytes += chunk.length - from;
  }

  /** Call at end of file. */
  finish(): CodexRolloutRecord[] {
    if (!this.done && this.pendingBytes > 0) this.takeLine();
    this.done = true;
    return this.records;
  }

  private overflow(): never {
    throw new Error(`Startup prefix exceeds ${this.maxBytes.toLocaleString('en-US')} bytes before the opening input; inspect it explicitly instead of silently truncating it.`);
  }

  private takeLine(): void {
    this.lineNumber++;
    const bytes = new Uint8Array(this.pendingBytes);
    let offset = 0;
    for (const part of this.pending) { bytes.set(part, offset); offset += part.length; }
    this.pending = [];
    this.pendingBytes = 0;
    let text: string;
    try {
      text = this.decoder.decode(bytes);
    } catch {
      throw new Error(`Rollout line ${this.lineNumber} is not valid UTF-8.`);
    }
    if (text.endsWith('\r')) text = text.slice(0, -1);
    if (!text.trim()) return;
    let record: CodexRolloutRecord;
    try {
      record = JSON.parse(text);
    } catch {
      throw new Error(`Rollout line ${this.lineNumber} is not valid JSON.`);
    }
    this.records.push(record);
    if (isCodexOpeningInput(record)) this.done = true;
  }
}

const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Candidate `sessions/YYYY/MM/DD` segments for a Codex thread's rollout, or null
 * when the id carries no creation time. Codex thread ids are UUIDv7 (first 48
 * bits are milliseconds) and rollouts are filed by local creation date; the
 * adjacent days absorb clock and time-zone edges. Throws on a malformed id.
 */
export function codexRolloutDayCandidates(threadId: string): string[][] | null {
  if (!THREAD_ID.test(threadId)) throw new Error('Invalid Codex thread id.');
  if (threadId[14] !== '7') return null;
  const created = parseInt(threadId.replace(/-/g, '').slice(0, 12), 16);
  return [0, -1, 1].map(offset => {
    const day = new Date(created + offset * 86_400_000);
    return [String(day.getFullYear()), String(day.getMonth() + 1).padStart(2, '0'), String(day.getDate()).padStart(2, '0')];
  });
}
