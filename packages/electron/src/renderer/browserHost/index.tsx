import React, { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
import type { PanelHostComponents, PanelSessionTranscriptProps } from '@nimbalyst/extension-sdk';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { AgentSessionPanel } from '../components/AgentMode/AgentSessionPanel';
import { DialogProvider } from '../contexts/DialogContext';
import { sessionDraftHydratedAtom, sessionDraftInputAtom, sessionProcessingAtom, sessionStoreAtom } from '../store/atoms/sessions';
import { sessionQueuedPromptsAtom } from '../store/atoms/sessionTranscript';
import type { BrowserHostInfo, BrowserHostSession, BrowserHostSessionHistory } from '../../shared/browserHost';
import { getTheme, registerThemeContribution } from '@nimbalyst/runtime';
import { applyThemeToDOM } from '../hooks/useTheme';
import { BrowserWorkspaceViews } from './BrowserExtensions';
import '../index.css';
import '../styles/components.css';
import './browserHost.css';

const BrowserPdf = lazy(() => import('./BrowserPdf'));
const BrowserSessionHistory = lazy(() => import('./BrowserSessionHistory'));

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

function useRefresh<T>(load: (signal: AbortSignal) => Promise<T>, apply: (data: T) => void, interval: number, revision = 0) {
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

function Session({ token, id, workspacePath, collapseTranscript, className }: {
  token: string; id: string; workspacePath: string; collapseTranscript?: boolean; className?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [refresh, setRefresh] = useState(0);
  const path = '/sessions/' + encodeURIComponent(id);
  const loadSession = React.useCallback(async (signal: AbortSignal) => {
    const response = await request(token, path, { signal });
    const data = await response.json() as BrowserHostSession;
    return {
      ...data,
      workspacePath,
      messages: data.messages.map((message) => ({ ...message, createdAt: new Date(message.createdAt) })),
    };
  }, [token, path, workspacePath]);
  const updateSnapshot = React.useCallback((snapshot: Awaited<ReturnType<typeof loadSession>>) => {
    if (!store.get(sessionDraftHydratedAtom(id))) {
      store.set(sessionDraftInputAtom(id), snapshot.draftInput ?? '');
      store.set(sessionDraftHydratedAtom(id), true);
    }
    store.set(sessionStoreAtom(id), snapshot);
    store.set(sessionQueuedPromptsAtom(id), snapshot.queuedPrompts ?? []);
    const processing = snapshot.processing === true;
    if (store.get(sessionProcessingAtom(id)) !== processing) store.set(sessionProcessingAtom(id), processing);
    setLoaded(true);
  }, [id]);
  const error = useRefresh(loadSession, updateSnapshot, 3000, refresh);

  async function mutate(action: string, input?: unknown) {
    try {
      await request(token, path + '/' + action, postJson(input ?? {}));
      setFeedback('');
      if (action !== 'draft') setRefresh((previous) => previous + 1);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Session request failed');
      throw err;
    }
  }

  if (!loaded) return <p role="status">{error || 'Loading session…'}</p>;
  return (
    <section className={className ? `browser-host-session ${className}` : 'browser-host-session'}>
      <AgentSessionPanel sessionId={id} workspacePath={workspacePath} collapseTranscript={collapseTranscript}
        browserSession={{
          submit: (prompt) => mutate('prompt', { prompt }),
          interrupt: () => mutate('interrupt'),
          persistDraft: (draft) => mutate('draft', { draft }),
          error: feedback || error,
        }} />
    </section>
  );
}

function Workspace({ token, info, disconnect }: { token: string; info: BrowserHostInfo; disconnect: () => void }) {
  useEffect(() => {
    document.title = `${info.workspaceName} – Nimbalyst`;
    return () => { document.title = 'Nimbalyst'; };
  }, [info.workspaceName]);
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
  const [sessions, setSessions] = useState<BrowserHostSessionHistory>();
  const [revision, setRevision] = useState(0);
  const refreshHistory = React.useCallback(() => setRevision((value) => value + 1), []);
  const [selected, setSelected] = useState('');
  const panelComponents = React.useMemo<PanelHostComponents>(() => ({
    SessionTranscript({ sessionId, collapseTranscript, className }: PanelSessionTranscriptProps) {
      return <Session key={sessionId} token={token} id={sessionId} workspacePath={info.workspacePath ?? ''} collapseTranscript={collapseTranscript} className={className} />;
    },
  }), [token, info.workspacePath]);
  const loadSessions = React.useMemo(() => async (signal: AbortSignal) => (
    await request(token, '/session-history', { signal })
  ).json() as Promise<BrowserHostSessionHistory>, [token, revision]);
  const error = useRefresh(loadSessions, setSessions, 6000);
  const sessionId = selected || sessions?.find((session) => !session.isArchived)?.id;
  const loadPdf = React.useCallback(async () => (await request(token, '/pdf')).arrayBuffer(), [token]);
  const extensionRequest = React.useCallback((path: string, init?: RequestInit) => request(token, path, init), [token]);
  useLayoutEffect(() => {
    const previous = window.electronAPI;
    const bridge = {
      ...previous,
      aiGetModels() {
        return bridge.invoke('ai:getModels');
      },
      async invoke(channel: string, ...args: unknown[]) {
        if (channel === 'workspace:get-state') return {};
        if (channel === 'workspace:update-state') return { success: true };
        if (channel === 'claude-code:answer-tool-permission' || channel === 'messages:respond-to-prompt') {
          const response = args[0] as {
            sessionId: string; promptId?: string; requestId?: string; promptType?: string; response: { decision: string };
          };
          if (channel === 'messages:respond-to-prompt' && response?.promptType !== 'permission_request') {
            throw new Error('This interactive prompt is unavailable in the browser');
          }
          return (await extensionRequest('/sessions/' + encodeURIComponent(response.sessionId) + '/permission',
            postJson({ requestId: response.requestId ?? response.promptId, decision: response.response.decision }))).json();
        }
        if (!channel.startsWith('sessions:') && ![
          'worktree:get-batch', 'ai:getModels', 'ai:compactSession', 'ai:deleteQueuedPrompt', 'action-prompts:list',
        ].includes(channel)) {
          throw new Error('This desktop action is unavailable in the browser');
        }
        const { result } = await (await extensionRequest('/session-history/command', postJson({ channel, args }))).json();
        if (result?.success === false) throw new Error(result.error ?? 'Session action failed');
        if (channel.startsWith('sessions:update-')) refreshHistory();
        return result;
      },
    } as typeof window.electronAPI;
    window.electronAPI = bridge;
    return () => { if (window.electronAPI === bridge) window.electronAPI = previous; };
  }, [extensionRequest, refreshHistory]);


  return (
    <main className="browser-host-workspace">
      <header className="browser-host-toolbar">
        <h1>{info.workspaceName}</h1>
        <button type="button" onClick={disconnect}>Disconnect</button>
      </header>
      <BrowserWorkspaceViews request={extensionRequest} pdfName={info.pdfName}
        workspacePath={info.workspacePath ?? ''} openSession={setSelected} components={panelComponents} pdf={info.pdfName ? (
          <Suspense fallback={<p role="status">Loading PDF Viewer…</p>}>
            <BrowserPdf fileName={info.pdfName} loadPdf={loadPdf} />
          </Suspense>
        ) : null}>
        <div className="browser-host-sessions">
          <aside className="browser-host-session-history" aria-label="Sessions">
            {error && <p role="status">{error}</p>}
            {!sessions && !error && <p role="status">Loading sessions…</p>}
            {sessions && <Suspense fallback={<p role="status">Loading sessions…</p>}>
              <BrowserSessionHistory workspacePath={info.workspacePath ?? ''} sessions={sessions}
                selected={sessionId ?? null} openSession={setSelected} refresh={refreshHistory} request={extensionRequest} />
            </Suspense>}
          </aside>
          {sessionId && <Session key={sessionId} token={token} id={sessionId} workspacePath={info.workspacePath ?? ''} />}
        </div>
      </BrowserWorkspaceViews>
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

  if (info) return <Provider store={store}>
    <DialogProvider workspacePath={info.workspacePath}>
      <Workspace token={token} info={info} disconnect={() => {
        setInfo(undefined);
        setToken('');
      }} />
    </DialogProvider>
  </Provider>;

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
