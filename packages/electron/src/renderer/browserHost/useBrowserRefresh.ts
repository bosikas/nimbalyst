import { useEffect, useState } from 'react';

export function useBrowserRefresh<T>(
  load: (signal: AbortSignal) => Promise<T>, apply: (data: T) => void, interval: number, revision = 0,
) {
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: number;
    async function refresh() {
      try {
        if (!document.hidden) {
          const data = await load(controller.signal);
          if (controller.signal.aborted) return;
          apply(data);
          setError('');
        }
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Connection lost');
      } finally {
        if (!controller.signal.aborted) timer = window.setTimeout(refresh, interval);
      }
    }
    setError('');
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [load, apply, interval, revision]);
  return error;
}
