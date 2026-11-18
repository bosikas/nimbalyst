/**
 * Which stream-handler invocation owns a session's live turn.
 *
 * A new message for a session whose turn is still in flight aborts that turn
 * inside the provider. The aborted turn does not vanish: its generator yields a
 * final `complete` a moment later, and its handler would then settle the
 * session -- `endSession`, completion sound, queue dispatch, watcher stop --
 * while the newer turn is already running. The session reads as idle for the
 * rest of that turn, so the next message skips the queue and aborts it again.
 *
 * Each turn claims the session when it starts. A turn that is no longer the
 * owner when it reaches a terminal path was replaced and must leave the
 * session's state to the turn that replaced it. That holds after the newer
 * turn has finished and released too: it already settled the session.
 */

export interface TurnClaim {
  /** False once a newer turn has claimed the same session. */
  isCurrent(): boolean;
  /** Give the session up. A no-op when a newer turn already owns it. */
  release(): void;
}

const owners = new Map<string, symbol>();

export function claimTurn(sessionId: string): TurnClaim {
  const token = Symbol(sessionId);
  owners.set(sessionId, token);
  return {
    isCurrent: () => owners.get(sessionId) === token,
    release: () => {
      if (owners.get(sessionId) === token) owners.delete(sessionId);
    },
  };
}
