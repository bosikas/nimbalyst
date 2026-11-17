// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { issueSessionWakeGrant, consumeSessionWakeGrant, revokeSessionWakeGrant } from '../sessionWakeGrants';

const scope = { extensionId: 'com.example.ci', workspacePath: '/workspace' };

describe('session wake grants', () => {
  it('allows one callback only, without allowing another extension or workspace to consume it', () => {
    const token = issueSessionWakeGrant(scope, 'session-1');
    expect(() => consumeSessionWakeGrant({ ...scope, extensionId: 'other' }, token)).toThrow(/Invalid/);
    expect(() => consumeSessionWakeGrant({ ...scope, workspacePath: '/other' }, token)).toThrow(/Invalid/);
    expect(consumeSessionWakeGrant(scope, token)).toBe('session-1');
    expect(() => consumeSessionWakeGrant(scope, token)).toThrow(/Invalid/);
  });

  it('revokes canceled watches and expires grants after 24 hours', () => {
    const token = issueSessionWakeGrant(scope, 'session-1');
    revokeSessionWakeGrant(scope, token);
    expect(() => consumeSessionWakeGrant(scope, token)).toThrow(/Invalid/);
    const expired = issueSessionWakeGrant(scope, 'session-1', 0);
    expect(() => consumeSessionWakeGrant(scope, expired, 24 * 60 * 60 * 1000)).toThrow(/Invalid/);
  });
});
