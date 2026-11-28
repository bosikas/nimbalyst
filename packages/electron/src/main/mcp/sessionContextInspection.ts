import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { readCodexContext, readCodexContextEvidence, readCodexPreparedGuidance } from '@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection';
import { readVibePreparedContext } from '@nimbalyst/runtime/ai/server/providers/vibeContextInspection';
import { homedir } from 'os';
import { join } from 'path';
import { readCodexRecordedStartup } from './codexRolloutStartup';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import { getToolBudgetSnapshot } from './toolBudgetService';
import { readClaudeContextInspection } from './claudeContextInspection';
import { readVibeContextGroups, recordedVibeStartup } from './vibeContextInspection';
import { getDatabase } from '../database/initialize';
import { asObject, str } from './claudeContextReport';

const CLAUDE_PROVIDERS = new Set(['claude-code', 'claude-code-cli']);

export async function getSessionContextInspection(
  sessionId: string,
  workspacePath: string,
  { audience = 'agent' }: { audience?: 'agent' | 'desktop' | 'browser' } = {},
) {
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.workspacePath || !sameWorkspaceIdentity(session.workspacePath, workspacePath)) throw new Error('Session is not in this workspace.');
  const metadata = asObject(session.metadata);
  const includeRecordedStartup = audience === 'desktop';
  const selection = {
    model: session.model ?? null,
    effort: str(metadata?.effortLevel),
    thinkingMode: str(metadata?.thinkingMode),
  };
  const instructionSnapshot = asObject(metadata?.instructionSnapshot);
  const instructionSelection = session.provider === 'openai-codex' || session.provider === 'claude-code'
    ? {
        fileSelected: !!instructionSnapshot,
        filePath: includeRecordedStartup ? str(instructionSnapshot?.path) : null,
        skipDefaultInstructions: metadata?.skipDefaultInstructions === true,
      }
    : null;
  const nativeUsage = {
    source: 'Stored provider-reported usage. Current context and cumulative spend are different quantities.',
    value: session.tokenUsage ?? metadata?.tokenUsage ?? null,
  };
  if (session.provider === 'mistral-vibe') {
    const cached = readVibePreparedContext(sessionId);
    const prepared = cached?.nativeSessionId === session.providerSessionId || !session.providerSessionId ? cached : undefined;
    const acceptedModel = prepared?.acceptedModel ?? await storedVibeModel(sessionId, session.providerSessionId);
    const recordedStartup = includeRecordedStartup
      ? await recordedVibeStartup(session.providerSessionId, RECORDED_TEXT_LIMIT)
      : undefined;
    return {
      sessionId,
      nativeUsage,
      selection,
      preparedRequest: prepared?.request ?? null,
      unavailable: 'No prepared Vibe prompt captured in this app process.',
      vibe: {
        groups: await readVibeContextGroups(session.providerSessionId),
        instructions: includeRecordedStartup ? prepared?.instructions : undefined,
        acceptedModel,
      },
      toolDefinitions: await getToolBudgetSnapshot(session.workspacePath),
      ...(recordedStartup ? { recordedStartup } : {}),
    };
  }
  if (session.provider && CLAUDE_PROVIDERS.has(session.provider)) {
    return {
      sessionId,
      nativeUsage,
      selection,
      instructionSelection,
      localText: includeRecordedStartup,
      // Prompt and appended system prompt text are raw user content; only the local inspector opts in.
      claude: await readClaudeContextInspection({ id: sessionId, provider: session.provider }, {
        includeText: includeRecordedStartup,
        live: audience !== 'browser',
        redactPaths: audience === 'browser',
      }),
    };
  }
  const codex = session.provider === 'openai-codex';
  return {
    sessionId,
    nativeUsage,
    selection,
    instructionSelection,
    preparedRequest: codex ? readCodexContext(sessionId) : null,
    preparedGuidance: codex && includeRecordedStartup ? readCodexPreparedGuidance(sessionId) : undefined,
    nativeEvidence: codex ? readCodexContextEvidence(sessionId) : undefined,
    unavailable: codex
      ? 'No prepared Codex request captured in this app process. Native context categories and active tool schemas are unavailable.'
      : 'Context records are unavailable for this provider.',
    toolDefinitions: await getToolBudgetSnapshot(session.workspacePath),
    // Native records are raw conversation and instruction text. Only local desktop IPC can read them.
    ...(includeRecordedStartup ? { recordedStartup: await recordedCodexStartup(session) } : {}),
  };
}

async function storedVibeModel(sessionId: string, nativeSessionId: string | undefined): Promise<string | null> {
  if (!nativeSessionId) return null;
  const { rows } = await getDatabase().query<{ content: string }>(
    `SELECT content FROM ai_agent_messages
     WHERE session_id = $1 AND source = 'mistral-vibe'
       AND direction = 'output' AND content LIKE '{"type":"nimbalyst_vibe_model_ack",%'
     ORDER BY created_at DESC, id DESC LIMIT 1`, [sessionId],
  );
  const acknowledgement = asObject(rows[0]?.content);
  return acknowledgement?.sessionId === nativeSessionId ? str(acknowledgement.model) : null;
}

/** Per-message text cap for IPC; byte counts still describe the full recorded text. */
const RECORDED_TEXT_LIMIT = 64 * 1024;

/** The native Codex log for this thread: recorded evidence, not the outbound request. */
async function recordedCodexStartup(session: { provider?: string; providerSessionId?: string }) {
  if (session.provider !== 'openai-codex' || !session.providerSessionId) {
    return { report: null, status: 'Not a Codex session with a native thread; no recorded native startup to inspect.' };
  }
  // CODEX_HOME is a config location, not a credential; Codex resolves it the same way.
  const codexHome = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  try {
    const report = await readCodexRecordedStartup(session.providerSessionId, codexHome, { maxTextBytes: RECORDED_TEXT_LIMIT });
    return report
      ? { report, status: 'Recorded in the local Codex rollout log. A recorded message is not proof of the complete outbound request.' }
      : { report: null, status: 'No local Codex rollout found for this thread; recorded native startup is unavailable.' };
  } catch (error) {
    return { report: null, status: `Recorded native startup unavailable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
