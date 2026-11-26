import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as JSXDevRuntime from 'react/jsx-dev-runtime';
import * as ExtensionSDK from '@nimbalyst/extension-sdk';
import type { ExtensionStorage, PanelHost, PanelHostComponents, PanelHostProps } from '@nimbalyst/extension-sdk';
import { navigateToTrackerReference } from '@nimbalyst/runtime';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { BrowserHostPanel, BrowserWorkspaceEvents } from '../../shared/browserHost';
import { createBrowserPanelWorkspace } from './browserPanelWorkspace';
import { useBrowserRefresh } from './useBrowserRefresh';
import { setPanelGutterBadge } from '../extensions/panels/panelGutterBadges';

export type PanelRequest = (path: string, init?: RequestInit) => Promise<Response>;
type PanelComponent = React.ComponentType<PanelHostProps>;
type PanelModule = { panels?: Record<string, { component?: PanelComponent }> };
type StorageScope = 'workspace' | 'global';

export interface BrowserPanelBridge {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  sessionAccess?: boolean;
}

export type RegisterBrowserPanelBridge = (bridge: BrowserPanelBridge) => () => void;

function panelStorage(
  state: Record<StorageScope, Record<string, unknown>>,
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>,
): ExtensionStorage {
  const workspace = new Map(Object.entries(state.workspace));
  const global = new Map(Object.entries(state.global));
  async function set(scope: StorageScope, key: string, value?: unknown) {
    const storage = scope === 'workspace' ? workspace : global;
    await invoke('extension:storage:set', { scope, key, value, delete: value === undefined });
    if (value === undefined) storage.delete(key);
    else storage.set(key, value);
  }
  const unsupportedSecret = async () => { throw new Error('Extension secret storage is unavailable in the browser'); };
  return {
    get: <T,>(key: string) => workspace.get(key) as T | undefined,
    set: (key, value) => set('workspace', key, value),
    delete: (key) => set('workspace', key),
    getGlobal: <T,>(key: string) => global.get(key) as T | undefined,
    setGlobal: (key, value) => set('global', key, value),
    deleteGlobal: (key) => set('global', key),
    getSecret: unsupportedSecret,
    setSecret: unsupportedSecret,
    deleteSecret: unsupportedSecret,
  };
}

const dependencies = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JSXRuntime,
  'react/jsx-dev-runtime': JSXDevRuntime,
  '@nimbalyst/extension-sdk': ExtensionSDK,
  '@nimbalyst/runtime': { navigateToTrackerReference, MaterialSymbol },
};
let modulesRegistered = false;

function registerPanelModules() {
  if (modulesRegistered) return;
  const nonce = document.querySelector<HTMLMetaElement>('meta[name="extension-import-map"]')?.content;
  if (!nonce) throw new Error('Browser extension loader is unavailable');
  Object.defineProperty(window, '__nimbalystBrowserPanelModules', { value: dependencies });
  const imports: Record<string, string> = {};
  for (const [name, values] of Object.entries(dependencies)) {
    const bindings = Object.keys(values)
      .filter((key) => key !== 'default' && /^[A-Za-z_$][\w$]*$/.test(key))
      .map((key) => `export const ${key} = m[${JSON.stringify(key)}];`);
    const source = `const m = window.__nimbalystBrowserPanelModules[${JSON.stringify(name)}];
      export default m.default ?? m;
      ${bindings.join('\n')}`;
    imports[name] = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  }
  const map = document.createElement('script');
  map.type = 'importmap';
  map.nonce = nonce;
  map.textContent = JSON.stringify({ imports });
  document.head.appendChild(map);
  modulesRegistered = true;
}

async function loadPanel(source: string, panel: BrowserHostPanel): Promise<PanelComponent> {
  registerPanelModules();
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    const module = await import(/* @vite-ignore */ url) as PanelModule;
    const component = module.panels?.[panel.id]?.component;
    if (!component) throw new Error(`Extension did not export ${panel.title}`);
    return component;
  } finally {
    URL.revokeObjectURL(url);
  }
}

class PanelBoundary extends React.Component<{ children: React.ReactNode }, { error: string }> {
  state = { error: '' };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || 'Extension panel could not render' };
  }

  render() {
    return this.state.error ? <p role="alert">{this.state.error}</p> : this.props.children;
  }
}

export function BrowserPanel({ request, extensionId, panel, workspacePath, openPanel, close, openFile, openSession, components, registerBridge }:
  { request: PanelRequest; extensionId: string; panel: BrowserHostPanel; workspacePath: string;
    openPanel: (id: string) => void; close: () => void; openFile: (path: string) => void; openSession: (id: string) => void;
    components?: PanelHostComponents; registerBridge?: RegisterBrowserPanelBridge }) {
  const [component, setComponent] = useState<PanelComponent | null>(null);
  const [storage, setStorage] = useState<ExtensionStorage>();
  const [error, setError] = useState('');
  const workspace = useMemo(() => createBrowserPanelWorkspace(workspacePath), [workspacePath]);
  const loadWorkspaceEvents = useCallback(async (signal: AbortSignal) => (
    await request('/workspace-events', { signal })
  ).json() as Promise<BrowserWorkspaceEvents>, [request]);
  useBrowserRefresh(loadWorkspaceEvents, workspace.update, 3000);
  const invoke = useCallback(async (channel: string, ...args: unknown[]) => {
    if (channel === 'notifications:navigate-to-session') {
      const input = args[0] as { sessionId?: unknown; workspacePath?: unknown } | undefined;
      if (typeof input?.sessionId !== 'string' || input.workspacePath !== workspacePath) throw new Error('Session navigation denied');
      openSession(input.sessionId);
      return;
    }
    const response = await request(`/extensions/${encodeURIComponent(extensionId)}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, args }),
    });
    return (await response.json() as { result: unknown }).result;
  }, [extensionId, openSession, request, workspacePath]);

  useLayoutEffect(() => {
    // Older extension bundles read their desktop bridge from window.
    const unregister = registerBridge?.({ invoke, sessionAccess: panel.sessionAccess });
    function onOpenSession(event: Event) {
      const { detail } = event as CustomEvent<{ sessionId?: string; workspacePath?: string }>;
      if (detail?.sessionId && detail.workspacePath === workspacePath) openSession(detail.sessionId);
    }
    window.addEventListener('open-ai-session', onOpenSession);
    return () => {
      window.removeEventListener('open-ai-session', onOpenSession);
      unregister?.();
    };
  }, [invoke, openSession, panel.sessionAccess, registerBridge, workspacePath]);

  useEffect(() => {
    const controller = new AbortController();
    let style: HTMLStyleElement | undefined;
    void (async () => {
      const [response, settings] = await Promise.all([
        request(`/extensions/${encodeURIComponent(extensionId)}/panel`, { signal: controller.signal }),
        invoke('extension:storage:get') as Promise<Record<StorageScope, Record<string, unknown>>>,
      ]);
      const assets = await response.json() as { source: string; css: string };
      if (controller.signal.aborted) return;
      const Component = await loadPanel(assets.source, panel);
      if (controller.signal.aborted) return;
      if (assets.css) {
        style = document.createElement('style');
        style.textContent = assets.css;
        document.head.appendChild(style);
      }
      setStorage(panelStorage(settings, invoke));
      setComponent(() => Component);
    })().catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => {
      controller.abort();
      style?.remove();
    };
  }, [extensionId, invoke, panel, request]);

  const host = useMemo(() => {
    const root = document.documentElement;
    const theme = () => root.dataset.theme ?? 'light';
    const host: Partial<PanelHost> & Pick<PanelHost, 'getWorkspaceFolders' | 'onWorkspaceEvent'> = {
      panelId: panel.id,
      extensionId,
      workspacePath,
      get theme() { return theme(); },
      getWorkspaceFolders: workspace.getWorkspaceFolders,
      onWorkspaceEvent: workspace.onWorkspaceEvent,
      getPrimaryFolderPath: () => workspacePath,
      onThemeChanged: (callback) => {
        const observer = new MutationObserver(() => callback(theme()));
        observer.observe(root, { attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
      },
      openFile,
      openPanel,
      close,
      storage,
      components: panel.sessionAccess ? components : undefined,
      setGutterBadge: (value, options) => setPanelGutterBadge(`${extensionId}.${panel.id}`, value, options?.tone),
      data: {
        query: async <T,>(sql: string, params?: unknown[]) => {
          const result = await invoke('extension:database:query', { sql, params }) as { rows: T[] };
          return result.rows;
        },
      },
      callBackendTool: async (toolName, args = {}) => {
        const response = await request(`/extensions/${encodeURIComponent(extensionId)}/tool`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ toolName, args }),
        });
        return (await response.json() as { result: unknown }).result;
      },
    };
    return Object.assign(host, { sessions: { open: openSession } }) as PanelHost;
  }, [close, components, extensionId, invoke, openFile, openPanel, openSession, panel.id, panel.sessionAccess, request, storage, workspace, workspacePath]);

  if (error) return <p role="alert">{error}</p>;
  const Component = component;
  if (!Component) return <p role="status">Loading {panel.title}…</p>;
  return <section className="browser-host-native-panel" aria-label={panel.title}>
    <PanelBoundary><Component host={host} /></PanelBoundary>
  </section>;
}
