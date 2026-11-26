import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentTranscriptPanel } from '@nimbalyst/runtime/ui/AgentTranscript/components/AgentTranscriptPanel';
import type { BrowserHostInfo, BrowserHostSession, BrowserHostSessionSummary } from '../../shared/browserHost';
import '../index.css';
import '../styles/components.css';
import './browserHost.css';

const BrowserPdf = lazy(() => import('./BrowserPdf'));

async function request(token: string, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch('/api' + path, {
    ...init,
    headers: { authorization: 'Bearer ' + token },
  });
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error ?? 'Linux host request failed');
  }
  return response;
}

function useRefresh<T>(load: (signal: AbortSignal) => Promise<T>, apply: (data: T) => void, interval: number) {
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
  }, [load, apply, interval]);
  return error;
}

function Session({ token, id }: { token: string; id: string }) {
  const [session, setSession] = useState<BrowserHostSession>();
  const [interruption, setInterruption] = useState('');
  const [interrupting, setInterrupting] = useState(false);
  const loadSession = React.useCallback(async (signal: AbortSignal) => {
    const response = await request(token, '/sessions/' + encodeURIComponent(id), { signal });
    const data = await response.json() as BrowserHostSession;
    return {
      ...data,
      messages: data.messages.map((message) => ({ ...message, createdAt: new Date(message.createdAt) })),
    };
  }, [token, id]);
  const error = useRefresh(loadSession, setSession, 3000);

  async function interrupt() {
    setInterrupting(true);
    setInterruption('');
    try {
      await request(token, '/sessions/' + encodeURIComponent(id) + '/interrupt', { method: 'POST' });
      setInterruption('Interrupt sent');
    } catch (err) {
      setInterruption(err instanceof Error ? err.message : 'Could not interrupt the session');
    } finally {
      setInterrupting(false);
    }
  }

  if (!session) return <p role="status">{error || 'Loading session…'}</p>;
  return (
    <section className="browser-host-session">
      <div className="browser-host-toolbar">
        <h2>{session.title ?? 'Untitled session'}</h2>
        <button type="button" disabled={interrupting} onClick={() => void interrupt()}>Interrupt</button>
        {interruption && <span role="status">{interruption}</span>}
      </div>
      {error && <p role="status">{error}</p>}
      <div className="browser-host-transcript">
        <AgentTranscriptPanel sessionId={id} sessionData={session} hideSidebar />
      </div>
    </section>
  );
}

function Workspace({ token, info, disconnect }: { token: string; info: BrowserHostInfo; disconnect: () => void }) {
  const [sessions, setSessions] = useState<BrowserHostSessionSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<'sessions' | 'extensions'>('sessions');
  const loadSessions = React.useCallback(async (signal: AbortSignal) => (
    await request(token, '/sessions', { signal })
  ).json() as Promise<BrowserHostSessionSummary[]>, [token]);
  const error = useRefresh(loadSessions, setSessions, 6000);
  const sessionId = sessions.find(({ id }) => id === selected)?.id ?? sessions[0]?.id;
  const loadPdf = React.useCallback(async () => (await request(token, '/pdf')).arrayBuffer(), [token]);

  return (
    <main className="browser-host-workspace">
      <header className="browser-host-toolbar">
        <h1>{info.workspaceName}</h1>
        <nav aria-label="Workspace views">
          <button type="button" aria-pressed={view === 'sessions'} onClick={() => setView('sessions')}>Sessions</button>
          <button type="button" aria-pressed={view === 'extensions'} onClick={() => setView('extensions')}>Extensions</button>
        </nav>
        <button type="button" onClick={disconnect}>Disconnect</button>
      </header>
      {view === 'sessions' ? (
        <div className="browser-host-sessions">
          <aside aria-label="Sessions">
            {error && <p role="status">{error}</p>}
            {sessions.length === 0 && !error && <p>No sessions</p>}
            {sessions.map(({ id, title }) => (
              <button type="button" key={id} aria-current={id === sessionId} onClick={() => setSelected(id)}>
                {title || 'Untitled session'}
              </button>
            ))}
          </aside>
          {sessionId && <Session key={sessionId} token={token} id={sessionId} />}
        </div>
      ) : (
        <section className="browser-host-extension" aria-label="PDF Viewer">
          <h2>PDF Viewer</h2>
          {info.pdfName ? (
            <Suspense fallback={<p role="status">Loading PDF Viewer…</p>}>
              <BrowserPdf fileName={info.pdfName} loadPdf={loadPdf} />
            </Suspense>
          ) : <p>No workspace PDF configured.</p>}
        </section>
      )}
    </main>
  );
}

function App() {
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<BrowserHostInfo>();
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(false);

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setConnecting(true);
    setError('');
    try {
      setInfo(await (await request(token, '')).json() as BrowserHostInfo);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Cannot connect to Linux host');
    } finally {
      setConnecting(false);
    }
  }

  if (info) return <Workspace token={token} info={info} disconnect={() => {
    setInfo(undefined);
    setToken('');
  }} />;

  return (
    <main className="browser-host-sign-in">
      <h1>Connect to Nimbalyst</h1>
      <form onSubmit={(event) => void connect(event)}>
        <label htmlFor="browser-host-token">Host access token</label>
        <input id="browser-host-token" type="password" autoComplete="off" value={token} required
          onChange={(event) => setToken(event.target.value.trim())} />
        <button type="submit" disabled={connecting}>Connect</button>
      </form>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
