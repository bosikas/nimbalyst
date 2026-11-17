import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: vi.fn() } }));
import { AISessionsRepository } from '../../../../storage/repositories/AISessionsRepository';
import { FrozenSessionDirectives } from '../sessionDirective';

describe('frozen instruction selection', () => {
  beforeEach(() => vi.mocked(AISessionsRepository.get).mockReset());
  it('keeps the custom profile, existing directive and exclusion stable together', async () => {
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ metadata: {
      sessionDirective: 'Report to the owner.', skipDefaultInstructions: true,
      instructionSnapshot: { path: '/profiles/review.md', content: 'Review only.' },
    } } as any);
    const frozen = new FrozenSessionDirectives();
    expect(await frozen.get('review')).toContain('Review only.');
    vi.mocked(AISessionsRepository.get).mockResolvedValue({ metadata: { sessionDirective: 'Changed', skipDefaultInstructions: false } } as any);
    expect(await frozen.skipsDefaults('review')).toBe(true);
    expect(await frozen.get('review')).toBe('Report to the owner.\n\nSession instruction file: /profiles/review.md\nReview only.');
    expect(AISessionsRepository.get).toHaveBeenCalledTimes(1);
    expect(await new FrozenSessionDirectives().get('other')).toBe('Changed');
  });
  it('blocks failed reads instead of silently loading excluded default files, then permits retry', async () => {
    vi.mocked(AISessionsRepository.get).mockRejectedValueOnce(new Error('storage unavailable')).mockResolvedValue({ metadata: { skipDefaultInstructions: true } } as any);
    const frozen = new FrozenSessionDirectives();
    await expect(frozen.get('review')).rejects.toThrow('storage unavailable');
    expect(await frozen.skipsDefaults('review')).toBe(true);
    expect(await frozen.skipsDefaults()).toBe(false);
  });
});
