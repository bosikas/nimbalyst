import type { QueuedPrompt, QueuedPromptsStore } from '../PGLiteQueuedPromptsStore';

export async function steerQueuedPrompt(
  store: Pick<QueuedPromptsStore, 'claimForSteering' | 'settleSteering'>,
  sessionId: string,
  promptId: string,
  steer: (prompt: QueuedPrompt) => Promise<'accepted' | 'unavailable' | 'unsupported'>,
) {
  const prompt = await store.claimForSteering(promptId, sessionId);
  if (!prompt) return 'already-claimed';

  let outcome: Awaited<ReturnType<typeof steer>>;
  try {
    outcome = await steer(prompt);
  } catch (cause) {
    const message = 'Vibe steering could not be confirmed. The message was saved in queue history.';
    await store.settleSteering(prompt, 'failed', message);
    throw new Error(message, { cause });
  }

  if (outcome === 'accepted') {
    await store.settleSteering(prompt, 'completed');
    return outcome;
  }
  return await store.settleSteering(prompt, 'pending') ? outcome : 'already-claimed';
}
