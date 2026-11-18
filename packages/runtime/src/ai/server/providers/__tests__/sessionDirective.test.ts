// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { registerSessionStoreFixture } from '../../../adapters/__tests__/sessionStoreFixture';
import type { SessionStore } from '../../../adapters/sessionStore';
import { FrozenSessionDirectives } from '../sessionDirective';

const getSession = vi.fn<SessionStore['get']>();
registerSessionStoreFixture(getSession);

describe('frozen instruction selection', () => {
  beforeEach(() => getSession.mockReset());
  it('keeps the custom profile, existing directive and exclusion stable together', async () => {
    getSession.mockResolvedValue({ metadata: {
      sessionDirective: 'Report to the owner.', skipDefaultInstructions: true,
      instructionSnapshot: { path: '/profiles/review.md', content: 'Review only.' },
    } } as any);
    const frozen = new FrozenSessionDirectives();
    expect(await frozen.get('review')).toContain('Review only.');
    getSession.mockResolvedValue({ metadata: { sessionDirective: 'Changed', skipDefaultInstructions: false } } as any);
    expect(await frozen.skipsDefaults('review')).toBe(true);
    expect(await frozen.get('review')).toBe('Report to the owner.\n\nSession instruction file: /profiles/review.md\nReview only.');
    expect(getSession).toHaveBeenCalledTimes(1);
    expect(await new FrozenSessionDirectives().get('other')).toBe('Changed');
  });
  it('blocks failed reads instead of silently loading excluded default files, then permits retry', async () => {
    getSession.mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue({ metadata: { skipDefaultInstructions: true } } as any);
    const frozen = new FrozenSessionDirectives();
    await expect(frozen.get('review')).rejects.toThrow('storage unavailable');
    expect(await frozen.skipsDefaults('review')).toBe(true);
    expect(await frozen.skipsDefaults()).toBe(false);
  });
});
