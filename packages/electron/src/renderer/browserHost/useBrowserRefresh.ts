import { useEffect, useState } from 'react';

export function useBrowserRefresh<T>(
  load: (signal: AbortSignal) => Promise<T>, apply: (data: T) => void, interval: number, revision = 0,
) {
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let inFlight = false;
    async function refresh() {
      if (document.hidden || inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        const data = await load(controller.signal);
        if (controller.signal.aborted) return;
        apply(data);
        setError('');
      } catch (err) {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Connection lost');
      } finally {
        inFlight = false;
        if (!controller.signal.aborted && !document.hidden) timer = window.setTimeout(refresh, interval);
      }
    }
    function onVisibilityChange() {
      window.clearTimeout(timer);
      void refresh();
    }
    setError('');
    document.addEventListener('visibilitychange', onVisibilityChange);
    void refresh();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [load, apply, interval, revision]);
  return error;
}
