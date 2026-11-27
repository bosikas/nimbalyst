/**
 * Shared by Vibe's stream completion and the Claude CLI's idle transition.
 * SessionNamingService registers the title writer without an import cycle.
 */

import { AISessionsRepository, AgentMessagesRepository } from '@nimbalyst/runtime';
import { extractUserPrompts } from '../metaAgentMessageText';
import { maybeAutoNameSession } from './sessionAutoName';

type ApplyTitleFn = (sessionId: string, title: string) => Promise<void>;

let applyTitleFn: ApplyTitleFn | null = null;

export function setAutoNameApplyTitleFn(fn: ApplyTitleFn | null): void {
  applyTitleFn = fn;
}

const attempted = new Set<string>();

/** Clean prompt text of the session's first visible user turn, or null. */
async function getFirstUserPrompt(sessionId: string): Promise<string | null> {
  const messages = await AgentMessagesRepository.list(sessionId, { limit: 50 });
  return extractUserPrompts(messages)[0] ?? null;
}

/**
 * Auto-name the session from its first user prompt if the agent hasn't named
 * it (best-effort; never throws into the turn-state callback).
 */
export async function maybeAutoNameSessionProduction(sessionId: string): Promise<void> {
  if (attempted.has(sessionId)) return;
  attempted.add(sessionId);
  try {
    const apply = applyTitleFn;
    if (!apply) {
      attempted.delete(sessionId);
      console.warn('[SessionAutoName] applyTitle not registered; skipping');
      return;
    }
    const outcome = await maybeAutoNameSession(sessionId, {
      isAlreadyNamed: async (id) => {
        const session = await AISessionsRepository.get(id);
        return !!session?.hasBeenNamed;
      },
      getFirstUserPrompt,
      applyTitle: apply,
    });
    if (outcome === 'no-usable-prompt') attempted.delete(sessionId);
    console.log(`[SessionAutoName] ${sessionId}: ${outcome}`);
  } catch (err) {
    // Allow a retry at the next turn boundary.
    attempted.delete(sessionId);
    console.warn('[SessionAutoName] auto-name failed:', err);
  }
}
