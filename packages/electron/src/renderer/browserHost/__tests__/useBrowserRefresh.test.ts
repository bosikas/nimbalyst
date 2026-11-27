import { act, renderHook } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useBrowserRefresh } from '../useBrowserRefresh';

it('refreshes on tab return immediately and avoids overlapping polls', async () => {
  let hidden = true;
  const visibility = vi.spyOn(document, 'hidden', 'get').mockImplementation(() => hidden);
  let finish!: (value: string) => void;
  const load = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
  const apply = vi.fn();
  const { unmount } = renderHook(() => useBrowserRefresh(load, apply, 60_000));
  try {
    expect(load).not.toHaveBeenCalled();
    hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(load).toHaveBeenCalledTimes(1);
    await act(async () => finish('fresh'));
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith('fresh');
  } finally {
    unmount();
    visibility.mockRestore();
  }
});
