import React, { lazy, Suspense, useEffect, useLayoutEffect, useState } from 'react';
import type { PanelSessionTranscriptProps } from '@nimbalyst/extension-sdk';
import { createRoot } from 'react-dom/client';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { AgentSessionPanel } from '../components/AgentMode/AgentSessionPanel';
import { sessionSelectionRootId } from '../components/AgenticCoding/sessionTreeModel';
import { registerContextInspectionDialog } from '../components/UnifiedAI/ContextInspectionDialog';
import { DialogProvider } from '../contexts/DialogContext';
import { createPanelHostComponents } from '../extensions/panels/panelHostComponents';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { activeWorkspacePathAtom } from '../store/atoms/openProjects';
import {
  sessionDraftHydratedAtom, sessionDraftInputAtom, sessionHasPendingInteractivePromptAtom, sessionListWorkspaceAtom,
  sessionProcessingAtom, sessionRegistryAtom, sessionStoreAtom,
} from '../store/atoms/sessions';
import { sessionQueuedPromptsAtom } from '../store/atoms/sessionTranscript';
import type { BrowserHostInfo, BrowserHostSession, BrowserHostSessionHistory } from '../../shared/browserHost';
import { getTheme, registerThemeContribution } from '@nimbalyst/runtime';
import { applyThemeToDOM } from '../hooks/useTheme';
import { BrowserWorkspaceViews } from './BrowserExtensions';
import type { BrowserPanelBridge, RegisterBrowserPanelBridge } from './BrowserPanel';
import { useBrowserRefresh } from './useBrowserRefresh';
import '../index.css';
import '../styles/components.css';
import './browserHost.css';

const BrowserPdf = lazy(() => import('./BrowserPdf'));
const BrowserSessionHistory = lazy(() => import('./BrowserSessionHistory'));
const BrowserWorkstream = lazy(() => import('./BrowserWorkstream'));

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
  const error = useBrowserRefresh(loadSession, updateSnapshot, 3000, refresh);

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

function PanelSession({ token, workspacePath, sessionId, ...props }:
  PanelSessionTranscriptProps & { token: string; workspacePath: string }) {
  return <Session key={sessionId} token={token} id={sessionId} workspacePath={workspacePath} {...props} />;
}

const sessionComponentCommands = new Set([
  'action-prompts:list', 'ai:compactSession', 'ai:deleteQueuedPrompt', 'ai:sendQueuedVibePromptNow',
  'claude-code:answer-tool-permission', 'mcp-config:get-context-inspection',
  'messages:respond-to-prompt', 'sessions:list-children', 'sessions:update-metadata',
]);

function Workspace({ token, info, disconnect }: { token: string; info: BrowserHostInfo; disconnect: () => void }) {
  const workspacePath = info.workspacePath ?? '';
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
  const panelComponents = React.useMemo(() => createPanelHostComponents(PanelSession, {
    token, workspacePath,
  }), [token, workspacePath]);
  const loadSessions = React.useMemo(() => async (signal: AbortSignal) => (
    await request(token, '/session-history', { signal })
  ).json() as Promise<BrowserHostSessionHistory>, [token, revision]);
  const applyHistory = React.useCallback((snapshot: BrowserHostSessionHistory) => {
    store.set(activeWorkspacePathAtom, workspacePath);
    store.set(sessionListWorkspaceAtom, workspacePath);
    store.set(sessionRegistryAtom, new Map(snapshot.map((session) => [session.id, session])));
    for (const session of snapshot) {
      store.set(sessionHasPendingInteractivePromptAtom(session.id), session.hasPendingInteractivePrompt === true);
    }
    setSessions(snapshot);
  }, [workspacePath]);
  const error = useBrowserRefresh(loadSessions, applyHistory, 6000);
  const sessionId = selected || sessions?.find((session) => !session.isArchived)?.id;
  const workstreamId = sessionId ? sessionSelectionRootId(sessionId, store.get(sessionRegistryAtom)) : undefined;
  const loadPdf = React.useCallback(async () => (await request(token, '/pdf')).arrayBuffer(), [token]);
  const extensionRequest = React.useCallback((path: string, init?: RequestInit) => request(token, path, init), [token]);
  const workspaceCommand = React.useCallback(async (channel: string, ...args: unknown[]) => {
    const { result } = await (await extensionRequest('/session-history/command', postJson({ channel, args }))).json();
    if (result?.success === false) throw new Error(result.error ?? 'Session action failed');
    if (channel === 'sessions:create-child' || channel.startsWith('sessions:update-')) refreshHistory();
    return result;
  }, [extensionRequest, refreshHistory]);
  const activePanelBridge = React.useRef<BrowserPanelBridge | undefined>(undefined);
  const registerPanelBridge = React.useCallback<RegisterBrowserPanelBridge>((panelBridge) => {
    activePanelBridge.current = panelBridge;
    return () => {
      if (activePanelBridge.current === panelBridge) activePanelBridge.current = undefined;
    };
  }, []);
  useLayoutEffect(() => {
    const previous = window.electronAPI;
    const bridge = {
      ...previous,
      async openExternal(url: string) {
        const target = new URL(url);
        if (target.protocol === 'https:' || target.protocol === 'http:') {
          window.open(target.href, '_blank', 'noopener,noreferrer');
        }
      },
      aiGetModels() {
        return bridge.invoke('ai:getModels');
      },
      async invoke(channel: string, ...args: unknown[]) {
        const panelBridge = activePanelBridge.current;
        if (panelBridge && !(panelBridge.sessionAccess && sessionComponentCommands.has(channel))) {
          return panelBridge.invoke(channel, ...args);
        }
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
          'mcp-config:get-context-inspection', 'worktree:update-pinned', 'ai:sendQueuedVibePromptNow',
        ].includes(channel)) {
          throw new Error('This desktop action is unavailable in the browser');
        }
        return workspaceCommand(channel, ...args);
      },
    } as typeof window.electronAPI;
    window.electronAPI = bridge;
    return () => { if (window.electronAPI === bridge) window.electronAPI = previous; };
  }, [extensionRequest, workspaceCommand]);


  return (
    <main className="browser-host-workspace">
      <BrowserWorkspaceViews request={extensionRequest} pdfName={info.pdfName}
        workspacePath={workspacePath} openSession={setSelected} components={panelComponents}
        connectionControl={
          <button className="browser-host-disconnect" type="button" onClick={disconnect}
            title={`Disconnect from ${info.workspaceName}`} aria-label={`Disconnect from ${info.workspaceName}`}>
            <MaterialSymbol icon="link_off" size={20} />
          </button>
        }
        registerPanelBridge={registerPanelBridge} pdf={info.pdfName ? (
          <Suspense fallback={<p role="status">Loading PDF Viewer…</p>}>
            <BrowserPdf fileName={info.pdfName} loadPdf={loadPdf} />
          </Suspense>
        ) : null}>
        <div className="browser-host-sessions">
          <aside className="browser-host-session-history" aria-label="Sessions">
            {error && <p role="status">{error}</p>}
            {!sessions && !error && <p role="status">Loading sessions…</p>}
            {sessions && <Suspense fallback={<p role="status">Loading sessions…</p>}>
              <BrowserSessionHistory openSession={setSelected} refresh={refreshHistory} request={extensionRequest} />
            </Suspense>}
          </aside>
          {sessionId && workstreamId && (
            <Suspense fallback={<p role="status">Loading session…</p>}>
              <BrowserWorkstream key={workstreamId} workstreamId={workstreamId}
                selected={sessionId} onSelect={setSelected} onCommand={workspaceCommand}
                renderSession={(id) => <Session key={id} token={token} id={id} workspacePath={workspacePath} />} />
            </Suspense>
          )}
        </div>
      </BrowserWorkspaceViews>
    </main>
  );
}

function App() {
  const loopbackToken = document.querySelector<HTMLMetaElement>('meta[name="browser-host-loopback-token"]')?.content;
  const [token, setToken] = useState('');
  const [info, setInfo] = useState<BrowserHostInfo>();
  const [error, setError] = useState('');
  const [connecting, setConnecting] = useState(Boolean(loopbackToken));

  const connect = React.useCallback(async (accessToken: string, signal?: AbortSignal) => {
    setConnecting(true);
    setError('');
    try {
      const workspace = await (await request(accessToken, '', { signal })).json() as BrowserHostInfo;
      if (!signal?.aborted) setInfo(workspace);
    } catch (err) {
      if (!signal?.aborted) setError(err instanceof Error ? err.message : 'Cannot connect to Linux host');
    } finally {
      if (!signal?.aborted) setConnecting(false);
    }
  }, []);

  useEffect(() => {
    if (!loopbackToken) return;
    const controller = new AbortController();
    void connect(loopbackToken, controller.signal);
    return () => controller.abort();
  }, [connect, loopbackToken]);

  if (info) return <Provider store={store}>
    <DialogProvider workspacePath={info.workspacePath}>
      <Workspace token={loopbackToken ?? token} info={info} disconnect={() => {
        setInfo(undefined);
        setToken('');
      }} />
    </DialogProvider>
  </Provider>;

  return (
    <main className="browser-host-sign-in">
      <h1>Connect to Nimbalyst</h1>
      {loopbackToken && connecting ? <p role="status">Connecting…</p> : (
        <form onSubmit={(event) => {
          event.preventDefault();
          void connect(loopbackToken ?? token);
        }}>
          {!loopbackToken && <>
            <label htmlFor="browser-host-token">Host access token</label>
            <input id="browser-host-token" type="password" autoComplete="off" value={token} required
              onChange={(event) => setToken(event.target.value.trim())} />
          </>}
          <button type="submit" disabled={connecting}>Connect</button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}

registerContextInspectionDialog();
createRoot(document.getElementById('root')!).render(<App />);
