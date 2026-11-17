import { randomUUID } from 'crypto';

interface Scope { extensionId: string; workspacePath: string }
interface Grant extends Scope { sessionId: string; expiresAt: number }
const grants = new Map<string, Grant>();
const TTL_MS = 24 * 60 * 60 * 1000;

/** Host-only issuance. Tokens are ephemeral, single-use, and never confer read access. */
export function issueSessionWakeGrant(scope: Scope, sessionId: string, now = Date.now()): string {
  for (const [token, grant] of grants) {
    if (grant.expiresAt <= now) grants.delete(token);
  }
  if (grants.size >= 10_000) throw new Error('Too many outstanding session wake grants');
  const token = randomUUID();
  grants.set(token, { ...scope, sessionId, expiresAt: now + TTL_MS });
  return token;
}

function requireGrant(scope: Scope, token: string, now: number): Grant {
  const grant = grants.get(token);
  if (!grant || grant.expiresAt <= now || grant.extensionId !== scope.extensionId || grant.workspacePath !== scope.workspacePath) {
    throw new Error('Invalid or expired session wake token');
  }
  return grant;
}

/** Consume synchronously before any async work so concurrent callbacks cannot both queue. */
export function consumeSessionWakeGrant(scope: Scope, token: string, now = Date.now()): string {
  const grant = requireGrant(scope, token, now);
  grants.delete(token);
  return grant.sessionId;
}

export function revokeSessionWakeGrant(scope: Scope, token: string): void {
  requireGrant(scope, token, Date.now());
  grants.delete(token);
}
