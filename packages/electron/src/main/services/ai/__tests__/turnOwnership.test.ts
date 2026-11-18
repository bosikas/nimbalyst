// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { claimTurn } from '../turnOwnership';

describe('claimTurn', () => {
  it('keeps a lone turn current until it releases', () => {
    const turn = claimTurn('lone');
    expect(turn.isCurrent()).toBe(true);
    turn.release();
  });

  it('makes the running turn stale when a new message claims the session', () => {
    // The reported case: a message typed while a turn was still running. The
    // aborted turn's late `complete` must not settle the session.
    const aborted = claimTurn('replaced');
    const followUp = claimTurn('replaced');
    expect(aborted.isCurrent()).toBe(false);
    expect(followUp.isCurrent()).toBe(true);
    followUp.release();
  });

  it('does not let the replaced turn release the newer claim', () => {
    const aborted = claimTurn('late-release');
    const followUp = claimTurn('late-release');
    aborted.release();
    expect(followUp.isCurrent()).toBe(true);
    followUp.release();
  });

  it('keeps a replaced turn stale after the newer turn has finished', () => {
    const aborted = claimTurn('outlived');
    const followUp = claimTurn('outlived');
    followUp.release();
    expect(aborted.isCurrent()).toBe(false);
  });

  it('tracks sessions independently', () => {
    const a = claimTurn('session-a');
    const b = claimTurn('session-b');
    expect(a.isCurrent()).toBe(true);
    expect(b.isCurrent()).toBe(true);
    a.release();
    b.release();
  });
});
