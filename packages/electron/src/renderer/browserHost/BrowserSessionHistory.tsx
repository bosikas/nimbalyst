import React, { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { SessionHistory } from '../components/AgenticCoding/SessionHistory';
import { persistSessionHistoryLayoutAtom } from '../store/atoms/agentMode';

interface Props {
  openSession: (id: string) => void;
  refresh: () => void;
  request: (path: string, init?: RequestInit) => Promise<Response>;
}

export default function BrowserSessionHistory({ openSession, refresh, request }: Props) {
  const [error, setError] = useState('');
  useLayoutEffect(() => {
    store.set(persistSessionHistoryLayoutAtom, false);
  }, []);

  const invoke = useCallback(async (channel: string, ...args: unknown[]) => {
    try {
      const response = await request('/session-history/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel, args }),
      });
      const { result } = await response.json();
      if (result?.success === false) throw new Error(result.error ?? 'Session action failed');
      setError('');
      if (channel === 'sessions:create' || channel.startsWith('sessions:update-')) refresh();
      return result;
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Session action failed';
      setError(message);
      return { success: false, error: message };
    }
  }, [refresh, request]);

  const browser = useMemo(() => ({
    openSession,
    refresh,
    async createSession() {
      const result = await invoke('sessions:create');
      if (result?.success && result.id) openSession(result.id);
    },
  }), [invoke, openSession, refresh]);

  return <Provider store={store}>
    {error && <p className="browser-host-history-error" role="alert">{error}</p>}
    <SessionHistory browser={browser} />
  </Provider>;
}
