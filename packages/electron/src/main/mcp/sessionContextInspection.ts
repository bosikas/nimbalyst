import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { readCodexContext, readCodexContextEvidence } from '@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection';
import { readVibePreparedContext } from '@nimbalyst/runtime/ai/server/providers/vibeContextInspection';
import { homedir } from 'os';
import { join } from 'path';
import { readCodexRecordedStartup } from './codexRolloutStartup';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import { getToolBudgetSnapshot } from './toolBudgetService';
import { readClaudeContextInspection } from './claudeContextInspection';
import { readVibeContextGroups, recordedVibeStartup } from './vibeContextInspection';

const CLAUDE_PROVIDERS = new Set(['claude-code', 'claude-code-cli']);

export async function getSessionContextInspection(
  sessionId: string,
  workspacePath: string,
  { audience = 'agent' }: { audience?: 'agent' | 'desktop' | 'browser' } = {},
) {
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.workspacePath || !sameWorkspaceIdentity(session.workspacePath, workspacePath)) throw new Error('Session is not in this workspace.');
  const metadata = typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata;
  const includeRecordedStartup = audience !== 'agent';
  const nativeUsage = {
    source: 'Stored provider-reported usage. Current context and cumulative spend are different quantities.',
    value: session.tokenUsage ?? metadata?.tokenUsage ?? null,
  };
  if (session.provider === 'mistral-vibe') {
    const prepared = readVibePreparedContext(sessionId);
    const recordedStartup = includeRecordedStartup
      ? await recordedVibeStartup(session.providerSessionId, RECORDED_TEXT_LIMIT, session.model)
      : undefined;
    return {
      sessionId,
      nativeUsage,
      preparedRequest: prepared?.request ?? null,
      unavailable: recordedStartup?.report ? undefined : 'The latest prepared request is available after a Vibe prompt runs in this app process.',
      vibe: {
        groups: await readVibeContextGroups(session.providerSessionId),
        instructions: includeRecordedStartup ? prepared?.instructions : undefined,
      },
      toolDefinitions: await getToolBudgetSnapshot(session.workspacePath),
      ...(recordedStartup ? { recordedStartup } : {}),
    };
  }
  if (session.provider && CLAUDE_PROVIDERS.has(session.provider)) {
    return {
      sessionId,
      nativeUsage,
      // Prompt and appended system prompt text are raw user content; only the local inspector opts in.
      claude: await readClaudeContextInspection({ id: sessionId, provider: session.provider }, { includeText: audience === 'desktop' }),
      unavailable: "Claude's built-in system prompt text is never exposed; only its section names and token counts are.",
    };
  }
  return {
    sessionId,
    nativeUsage,
    preparedRequest: readCodexContext(sessionId),
    nativeEvidence: readCodexContextEvidence(sessionId),
    unavailable: 'No prepared-request snapshot until a Codex turn runs in this app process. Native context categories and active loaded-tool set are unavailable. Original transcript bytes are not current model context.',
    toolDefinitions: await getToolBudgetSnapshot(session.workspacePath),
    // Recorded messages contain raw prompt text. User-facing inspectors opt in to reading it.
    ...(includeRecordedStartup ? { recordedStartup: await recordedCodexStartup(session) } : {}),
  };
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
