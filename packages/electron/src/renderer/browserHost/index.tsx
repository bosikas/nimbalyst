import React, { lazy, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AgentTranscriptPanel } from '@nimbalyst/runtime/ui/AgentTranscript/components/AgentTranscriptPanel';
import { pendingBrowserPermissions } from '../../shared/browserHost';
import type { BrowserHostInfo, BrowserHostSession, BrowserHostSessionSummary } from '../../shared/browserHost';
import { getTheme, registerThemeContribution } from '@nimbalyst/runtime';
import { applyThemeToDOM } from '../hooks/useTheme';
import { AIInput } from '../components/UnifiedAI/AIInput';
import { BrowserExtensions } from './BrowserExtensions';
import '../index.css';
import '../styles/components.css';
import './browserHost.css';

const BrowserPdf = lazy(() => import('./BrowserPdf'));

async function request(token: string, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set('authorization', 'Bearer ' + token);
  const response = await fetch('/api' + path, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const data = await response.json() as { error?: string };
    throw new Error(data.error ?? 'Linux host request failed');
  }
  return response;
}

function postJson(input: unknown): RequestInit {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) };
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
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState('');
  const loadSession = React.useCallback(async (signal: AbortSignal) => {
    const response = await request(token, '/sessions/' + encodeURIComponent(id), { signal });
    const data = await response.json() as BrowserHostSession;
    return {
      ...data,
      messages: data.messages.map((message) => ({ ...message, createdAt: new Date(message.createdAt) })),
    };
  }, [token, id]);
  const error = useRefresh(loadSession, setSession, 3000);

  async function mutate(action: string, init: RequestInit, message: string) {
    setBusy(true);
    setFeedback('');
    try {
      await request(token, '/sessions/' + encodeURIComponent(id) + '/' + action, init);
      setFeedback(message);
      return true;
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Session request failed');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function queuePrompt(value = draft) {
    const prompt = value.trim();
    if (!prompt || busy) return;
    if (prompt.length > 32000) {
      setFeedback('Prompts can be up to 32,000 characters');
      return;
    }
    if (await mutate('prompt', postJson({ prompt }), 'Prompt queued')) {
      setDraft((current) => current === value ? '' : current);
    }
  }

  if (!session) return <p role="status">{error || 'Loading session…'}</p>;
  const permissions = pendingBrowserPermissions(session.messages);
  return (
    <section className="browser-host-session">
      <div className="browser-host-toolbar">
        <h2>{session.title ?? 'Untitled session'}</h2>
        <button type="button" disabled={busy}
          onClick={() => void mutate('interrupt', { method: 'POST' }, 'Interrupt sent')}>Interrupt</button>
        {feedback && <span role="status">{feedback}</span>}
      </div>
      {error && <p role="status">{error}</p>}
      {permissions.map(({ requestId, toolName, rawCommand, patternDisplayName, warnings }) => (
        <section className="browser-host-permission" key={requestId} aria-label={`Permission for ${toolName}`}>
          <details>
            <summary>Permission requested for {toolName}</summary>
            <pre>{rawCommand || patternDisplayName}</pre>
            {warnings?.map((warning) => <p key={warning}>{warning}</p>)}
            <button type="button" disabled={busy} onClick={() => void mutate('permission',
              postJson({ requestId, decision: 'allow' }), 'Permission granted for this request')}>Allow once</button>
            <button type="button" disabled={busy} onClick={() => void mutate('permission',
              postJson({ requestId, decision: 'deny' }), 'Permission denied')}>Deny</button>
          </details>
        </section>
      ))}
      <div className="browser-host-transcript">
        <AgentTranscriptPanel sessionId={id} sessionData={session} hideSidebar />
      </div>
      <AIInput value={draft} onChange={setDraft} onSend={(value) => void queuePrompt(value)}
        placeholder="Send a prompt" disabled={busy} remoteSession enableSlashCommands={false}
        sessionHasMessages={session.messages.length > 0} />
    </section>
  );
}

function Workspace({ token, info, disconnect }: { token: string; info: BrowserHostInfo; disconnect: () => void }) {
  useEffect(() => {
    const appearance = info.appearance;
    const theme = appearance?.theme ?? 'system';
    const contribution = appearance?.contribution;
    if (contribution && !getTheme(theme)) {
      registerThemeContribution(contribution.extensionId, contribution.theme);
    }
    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => void applyThemeToDOM(theme);
    apply();
    if (theme === 'system' || theme === 'auto') preference.addEventListener('change', apply);
    return () => {
      preference.removeEventListener('change', apply);
      void applyThemeToDOM('system');
    };
  }, [info.appearance]);
  const [sessions, setSessions] = useState<BrowserHostSessionSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [view, setView] = useState<'sessions' | 'extensions'>('sessions');
  const loadSessions = React.useCallback(async (signal: AbortSignal) => (
    await request(token, '/sessions', { signal })
  ).json() as Promise<BrowserHostSessionSummary[]>, [token]);
  const error = useRefresh(loadSessions, setSessions, 6000);
  const sessionId = sessions.find(({ id }) => id === selected)?.id ?? sessions[0]?.id;
  const loadPdf = React.useCallback(async () => (await request(token, '/pdf')).arrayBuffer(), [token]);
  const extensionRequest = React.useCallback((path: string, init?: RequestInit) => request(token, path, init), [token]);
  const openSession = React.useCallback((id: string) => {
    setSelected(id);
    setView('sessions');
  }, []);

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
        <BrowserExtensions request={extensionRequest} pdfName={info.pdfName}
          workspacePath={info.workspacePath ?? ''} openSession={openSession} pdf={info.pdfName ? (
            <Suspense fallback={<p role="status">Loading PDF Viewer…</p>}>
              <BrowserPdf fileName={info.pdfName} loadPdf={loadPdf} />
            </Suspense>
          ) : null} />
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
