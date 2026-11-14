import { AISessionsRepository } from "@nimbalyst/runtime/storage/repositories/AISessionsRepository";
import { SessionFilesRepository } from "@nimbalyst/runtime/storage/repositories/SessionFilesRepository";
import { getDatabase } from "../database/initialize";
import { appendPendingPromptSection, collectPendingPromptDescriptionsFromRawRows } from "../services/sessionSummaryPrompt";

import { isSyntheticPrompt } from "./sessionCoachingSignals";
import { uniqueSessionFilePaths } from "./sessionFilePaths";
import { boundSessionOutput, sessionOutputFits } from "./sessionOutput";

function excerpt(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? Array.from(flat).slice(0, limit).join("") + "…" : flat;
}

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * Strip workspace path prefix from file paths to save context window space.
 * "/Users/person/sources/nimbalyst/packages/foo.ts" -> "packages/foo.ts"
 */
export function stripWorkspacePath(filePath: string, workspacePath: string): string {
  if (workspacePath && (filePath === workspacePath || filePath.startsWith(workspacePath + "/"))) {
    const relative = filePath.slice(workspacePath.length);
    return relative.startsWith("/") ? relative.slice(1) : relative;
  }
  return filePath;
}

// ─── Last-assistant-response aggregation ────────────────────────────

/**
 * Minimal DB surface for the assistant-response aggregator. Keeps the helper
 * testable without dragging the full PGLite/SQLite adapter into the test
 * harness.
 */
export interface MessageRowDb {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Assemble the most recent assistant response for a session.
 *
 * Chunked providers (claude-code streaming, codex `agent_message_delta`s)
 * split one assistant turn across many rows. The naive
 * `ORDER BY id DESC LIMIT 1` returns the trailing fragment of the final
 * delta, not the assembled reply. We instead take every assistant row whose
 * id is greater than the most recent user-row id, in ascending order, and
 * join their `searchable_text` values.
 *
 * Returns null when the session has no assistant content yet. Output is
 * capped at 2000 chars to match the existing tool-output contract.
 */
export async function fetchLastAssistantResponse(
  db: MessageRowDb,
  sessionId: string,
  maxLen: number = 2000,
): Promise<string | null> {
  const { rows: lastUserRows } = await db.query<{ id: number }>(
    `SELECT id FROM ai_agent_messages
     WHERE session_id = $1 AND message_kind = 'user'
     ORDER BY id DESC
     LIMIT 1`,
    [sessionId]
  );
  const lastUserId = lastUserRows.length > 0 ? lastUserRows[0].id : 0;
  const { rows: assistantRows } = await db.query<{ searchable_text: string | null }>(
    `SELECT searchable_text FROM ai_agent_messages
     WHERE session_id = $1 AND message_kind = 'assistant'
       AND searchable_text IS NOT NULL
       AND id > $2
     ORDER BY id ASC`,
    [sessionId, lastUserId]
  );
  const assembled = assistantRows
    .map((row) => row.searchable_text ?? "")
    .filter((t) => t.length > 0)
    .join("\n");
  if (assembled.length === 0) return null;
  return assembled.slice(0, maxLen);
}

// ─── Tool handlers ──────────────────────────────────────────────────

export async function handleGetSessionSummary(
  targetSessionId: string | undefined,
  currentSessionId: string,
  workspaceId: string,
  includeDetails = false,
): Promise<string> {
  const sessionId = targetSessionId || currentSessionId;

  const session = await AISessionsRepository.get(sessionId);
  if (!session) {
    return `Error: Session ${sessionId} not found`;
  }

  // Phase 3 of canonical-transcript-deprecation: ai_transcript_events is
  // going away. The session-context MCP queries now read ai_agent_messages
  // directly via the message_kind column populated at write time.
  const db = getDatabase();
  const { rows: userRows } = await db.query<any>(
    `SELECT searchable_text, metadata FROM ai_agent_messages
     WHERE session_id = $1 AND message_kind = 'user'
       AND searchable_text IS NOT NULL
     ORDER BY id ASC`,
    [sessionId]
  );
  const userPrompts = userRows.map((row: any) => row.searchable_text || "").filter((t: string) => t.length > 0);

  const lastResponse = await fetchLastAssistantResponse(db, sessionId, Infinity);

  // Keep actionable interactive prompts at the end of every summary. Raw
  // prompt rows are filtered in SQL so large sessions do not need to load their
  // complete transcript just to find an unmatched question.
  // Synthetic terminal rows (e.g. a question superseded by a new user turn)
  // carry only the tool_use_id, so they are matched by their row type.
  const { rows: promptRows } = await db.query<{ content: string }>(
    `SELECT content FROM ai_agent_messages
     WHERE session_id = $1
       AND (hidden = FALSE OR hidden IS NULL)
       AND (
         content LIKE '%AskUserQuestion%'
         OR content LIKE '%PromptForUserInput%'
         OR content LIKE '%RequestUserInput%'
         OR content LIKE '%ToolPermission%'
         OR content LIKE '%ExitPlanMode%'
         OR content LIKE '%developer_git_commit_proposal%'
         OR content LIKE '%ask_user_question_response%'
         OR content LIKE '%request_user_input_response%'
         OR content LIKE '%permission_response%'
         OR content LIKE '%git_commit_proposal%'
         OR content LIKE '%exit_plan_mode_%'
         OR content LIKE '%nimbalyst_tool_result%'
       )
     ORDER BY id ASC`,
    [sessionId]
  );
  const pendingPrompts = collectPendingPromptDescriptionsFromRawRows(promptRows);

  let editedFiles: string[] = [];
  try {
    const fileLinks = await SessionFilesRepository.getFilesBySession(
      sessionId,
      "edited"
    );
    editedFiles = await uniqueSessionFilePaths(fileLinks);
  } catch {
    // File tracking might not be available for all sessions
  }

  const lines: string[] = [];
  lines.push(
    `Session: "${session.title || "Untitled"}" (${sessionId})`
  );
  lines.push(
    `Provider: ${session.provider}${session.model ? ` | Model: ${session.model}` : ""}`
  );
  lines.push(
    `Created: ${formatDate(session.createdAt)} | Last active: ${formatDate(session.updatedAt)}`
  );

  if (session.parentSessionId) {
    const parent = await AISessionsRepository.get(session.parentSessionId);
    if (parent) {
      lines.push(`Workstream: "${parent.title || "Untitled"}"`);
    }
  }

  const metadata = session.metadata as Record<string, unknown> | undefined;
  const phase = metadata?.phase as string | undefined;
  const tags = metadata?.tags as string[] | undefined;
  if (phase) {
    lines.push(`Phase: ${phase}`);
  }
  if (tags && tags.length > 0) {
    lines.push(`Tags: ${tags.map(t => `#${t}`).join(", ")}`);
  }

  lines.push("");

  const header = lines.join("\n");
  const render = (prompts: string[], response: string | null, files: string[], pending: string[]) => {
    const body = [header];
    body.push(`User prompts (${userPrompts.length} turns; ${prompts.length} shown):`);
    body.push(...prompts.map((prompt, i) => `${i + 1}. "${prompt}"`));
    if (response) body.push("", "Last agent response:", response);
    if (editedFiles.length > 0) {
      body.push("", `Files edited (${editedFiles.length}; ${files.length} shown):`);
      body.push(...files.map(file => `- ${stripWorkspacePath(file, workspaceId)}`));
    }
    return appendPendingPromptSection(body.join("\n"), pending);
  };
  const full = render(userPrompts, lastResponse, editedFiles, pendingPrompts);
  const humanPrompts = userRows
    .filter((row: any) => row.searchable_text && !isSyntheticPrompt(row.searchable_text, row.metadata))
    .map((row: any) => row.searchable_text as string);
  // Original intent plus the three most recent decisions; no recursive expansion
  // of inbox reports, generated briefs, or historical prompt bodies.
  const selected = humanPrompts.length > 4
    ? [humanPrompts[0], ...humanPrompts.slice(-3)] : humanPrompts;
  const compact = render(
    selected.map((text: string) => excerpt(text, 600)),
    lastResponse ? excerpt(lastResponse, 2000) : null,
    editedFiles.slice(0, 20),
    pendingPrompts.slice(0, 8).map(text => excerpt(text, 600)),
  );
  // Explicit details still respect the transport ceiling. Oversized details use
  // the useful compact view rather than a prefix containing only old prompts.
  const detailsFit = sessionOutputFits(full);
  return boundSessionOutput(full, includeDetails && detailsFit ? full : compact);
}
