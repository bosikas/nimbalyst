import { AISessionsRepository } from '@nimbalyst/runtime/storage/repositories/AISessionsRepository';
import { readCodexContext } from '@nimbalyst/runtime/ai/server/providers/codex/codexContextInspection';
import { sameWorkspaceIdentity } from '../utils/workspaceIdentity';
import { getToolBudgetSnapshot } from './toolBudgetService';

export async function getSessionContextInspection(sessionId: string, workspacePath: string) {
  const session = await AISessionsRepository.get(sessionId);
  if (!session?.workspacePath || !sameWorkspaceIdentity(session.workspacePath, workspacePath)) throw new Error('Session is not in this workspace.');
  const metadata = typeof session.metadata === 'string' ? JSON.parse(session.metadata) : session.metadata;
  return {
    sessionId,
    nativeUsage: { source: 'Stored provider-reported usage; not a local byte estimate. Current context and cumulative spend are different quantities.', value: session.tokenUsage ?? metadata?.tokenUsage ?? null },
    preparedRequest: readCodexContext(sessionId),
    unavailable: 'No prepared-request snapshot until a Codex turn runs in this app process. Native context categories and active loaded-tool set are unavailable. Original transcript bytes are not current model context.',
    toolDefinitions: await getToolBudgetSnapshot(session.workspacePath),
  };
}
