// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { resolveCodexBaseInstructions, setCodexBaseInstructionsLoader } from '../codexBaseInstructions';

afterEach(() => setCodexBaseInstructionsLoader());

it('reads a fresh file for new threads and leaves live/resumed threads independent of the global source', () => {
  let content = 'Original file.';
  const read = vi.fn(() => content);
  setCodexBaseInstructionsLoader(read);
  const options = { transport: 'app-server' as const, hasLiveSession: false };
  const firstThreadSnapshot = resolveCodexBaseInstructions(options);
  content = 'Edited externally.';
  expect(resolveCodexBaseInstructions(options)).toBe('Edited externally.');
  expect(firstThreadSnapshot).toBe('Original file.');
  read.mockImplementation(() => { throw new Error('Selected file missing'); });
  expect(resolveCodexBaseInstructions({ ...options, hasLiveSession: true })).toBeUndefined();
  expect(resolveCodexBaseInstructions({ ...options, persistedThreadId: 'saved-thread' })).toBeUndefined();
  expect(read).toHaveBeenCalledTimes(2);
  expect(() => resolveCodexBaseInstructions(options)).toThrow('Selected file missing');
});

it('preserves native defaults without a source, rejects invalid sources and unsupported transports explicitly', () => {
  const options = { transport: 'app-server' as const, hasLiveSession: false };
  expect(resolveCodexBaseInstructions(options)).toBeUndefined();
  setCodexBaseInstructionsLoader(() => '  ');
  expect(() => resolveCodexBaseInstructions(options)).toThrow('empty or invalid');
  setCodexBaseInstructionsLoader(() => 'Custom base.');
  expect(() => resolveCodexBaseInstructions({ ...options, transport: 'sdk' })).toThrow('app-server');
});
