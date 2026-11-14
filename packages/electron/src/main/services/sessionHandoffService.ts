import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { getDatabase } from '../database/initialize';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import { buildHandoffSnapshot, buildHandoffPrompt, retainHandoffState, type HandoffBrief, type RetainedHandoffState } from './sessionHandoff';
import { collectPendingPromptDescriptionsFromRawRows } from './sessionSummaryPrompt';
import { boundSessionOutput } from '../mcp/sessionOutput';

/** Always reload source state. A caller-supplied path is never read or trusted. */
export async function readHandoffSource(sessionId: string, workspacePath: string) {
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.workspacePath || !sameWorkspaceIdentity(session.workspacePath, workspacePath)) throw new Error('Handoff source is not in this workspace.');
  const db = getDatabase();
  const { rows } = await db.query<{ id: string | number; searchable_text: string | null; metadata: unknown; content: string }>(
    `SELECT id, searchable_text, metadata, content FROM ai_agent_messages
     WHERE session_id = $1 AND message_kind = 'user' ORDER BY id ASC`, [sessionId]);
  const { rows: queued } = await db.query(
    `SELECT id, prompt, status, attachments, document_context FROM queued_prompts
     WHERE session_id = $1 AND status IN ('pending', 'executing') ORDER BY created_at ASC, id ASC`, [sessionId]);
  const { rows: interactive } = await db.query<{ content: string }>(
    `SELECT content FROM ai_agent_messages WHERE session_id = $1
     AND (hidden = FALSE OR hidden IS NULL)
     AND (content LIKE '%AskUserQuestion%' OR content LIKE '%PromptForUserInput%'
       OR content LIKE '%RequestUserInput%' OR content LIKE '%ToolPermission%'
       OR content LIKE '%ExitPlanMode%' OR content LIKE '%developer_git_commit_proposal%'
       OR content LIKE '%ask_user_question_response%' OR content LIKE '%request_user_input_response%'
       OR content LIKE '%permission_response%' OR content LIKE '%git_commit_proposal%'
       OR content LIKE '%exit_plan_mode_%' OR content LIKE '%nimbalyst_tool_result%') ORDER BY id ASC`, [sessionId]);
  const pendingQuestions = collectPendingPromptDescriptionsFromRawRows(interactive);
  const metadata = typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata;
  const inherited = metadata?.continuationHandoff as RetainedHandoffState | undefined;
  const snapshot = buildHandoffSnapshot(sessionId, rows.map(row => ({ ...row, searchable_text: row.searchable_text ?? row.content })), queued, inherited);
  // Do not serialize SessionData.messages or unrelated nested session metadata.
  // The canonical transcript remains at source; this is a request/ownership ledger.
  return { session: {
    id: session.id, title: session.title, provider: session.provider, model: session.model,
    workspacePath: session.workspacePath, worktreeId: session.worktreeId,
    createdBySessionId: session.createdBySessionId, parentSessionId: session.parentSessionId,
  }, snapshot, pendingQuestions };
}

async function saveEvidence(value: unknown): Promise<string> {
  // Lazy Electron access: module imports are safe before app initialization.
  const { app } = await import('electron');
  const root = join(app.getPath('userData'), 'session-handoffs');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(root, 'handoff-'));
  const file = join(directory, 'evidence.json');
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  return file;
}

export async function prepareSessionHandoff(sessionId: string, workspacePath: string): Promise<string> {
  const source = await readHandoffSource(sessionId, workspacePath);
  const evidencePath = await saveEvidence(source);
  const review = {
    sourceSessionId: sessionId, sourceDigest: source.snapshot.digest, evidencePath,
    requestsToReview: source.snapshot.requests.map(r => ({ id: r.id, author: r.author, preview: Array.from(r.text).slice(0, 300).join(''), bytes: Buffer.byteLength(r.text, 'utf8') })),
    pendingQuestions: source.pendingQuestions, queuedCount: source.snapshot.queued.length,
    next: 'Read full request text in evidencePath. Call spawn_session with besideCaller=true, reporting="none" and handoff. Explicitly classify every human request and potentially active machine instruction pending/resolved/superseded with a reason. Keep authors distinct. Include active decisions, ownership, instructions and validation/evidence links. Stop source execution before successor edits. This tool does not create or stop sessions.',
  };
  return boundSessionOutput(JSON.stringify(review, null, 2), undefined, 'Read the complete review manifest and evidence file before preparing a handoff.');
}

export async function prepareReviewedHandoff(sessionId: string, workspacePath: string, brief: HandoffBrief, task: string) {
  const source = await readHandoffSource(sessionId, workspacePath);
  // Validate before writing evidence or creating a child. No permission/queue transfer.
  buildHandoffPrompt(source.snapshot, brief, task, '(pending evidence file)');
  if (source.pendingQuestions.length > 0) throw new Error('Resolve pending source questions/approvals before handing off: ' + source.pendingQuestions.join('; '));
  const id = randomUUID();
  const evidencePath = await saveEvidence({ ...source, handoffId: id, reviewedBrief: brief, continuationTask: task });
  const prompt = await boundSessionOutput(buildHandoffPrompt(source.snapshot, brief, task, evidencePath), undefined,
    `Fresh-session handoff. Read the full file for ALL active decisions, ownership, pending human requests and evidence before taking action. Durable reviewed ledger: ${evidencePath}`);
  return { prompt, state: retainHandoffState(source.snapshot, brief, id, evidencePath) };
}
