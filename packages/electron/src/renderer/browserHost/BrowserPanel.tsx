import React, { useEffect, useMemo, useState } from 'react';
import * as ReactDOM from 'react-dom';
import * as ReactDOMClient from 'react-dom/client';
import * as JSXRuntime from 'react/jsx-runtime';
import * as JSXDevRuntime from 'react/jsx-dev-runtime';
import * as ExtensionSDK from '@nimbalyst/extension-sdk';
import type { PanelHost, PanelHostProps } from '@nimbalyst/extension-sdk';
import type { BrowserHostPanel } from '../../shared/browserHost';

export type PanelRequest = (path: string, init?: RequestInit) => Promise<Response>;
type PanelComponent = React.ComponentType<PanelHostProps>;
type PanelModule = { panels?: Record<string, { component?: PanelComponent }> };

const dependencies = {
  react: React,
  'react-dom': ReactDOM,
  'react-dom/client': ReactDOMClient,
  'react/jsx-runtime': JSXRuntime,
  'react/jsx-dev-runtime': JSXDevRuntime,
  '@nimbalyst/extension-sdk': ExtensionSDK,
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

export function BrowserPanel({ request, extensionId, panel, workspacePath, openPanel, close, openFile, openSession }:
  { request: PanelRequest; extensionId: string; panel: BrowserHostPanel; workspacePath: string;
    openPanel: (id: string) => void; close: () => void; openFile: (path: string) => void; openSession: (id: string) => void }) {
  const [component, setComponent] = useState<PanelComponent | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let style: HTMLStyleElement | undefined;
    void (async () => {
      const response = await request(`/extensions/${encodeURIComponent(extensionId)}/panel`, { signal: controller.signal });
      const assets = await response.json() as { source: string; css: string };
      if (controller.signal.aborted) return;
      const Component = await loadPanel(assets.source, panel);
      if (controller.signal.aborted) return;
      if (assets.css) {
        style = document.createElement('style');
        style.textContent = assets.css;
        document.head.appendChild(style);
      }
      setComponent(() => Component);
    })().catch((error: Error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => {
      controller.abort();
      style?.remove();
    };
  }, [extensionId, panel, request]);

  const host = useMemo(() => {
    const root = document.documentElement;
    const theme = () => root.dataset.theme ?? 'light';
    const host: Partial<PanelHost> = {
      panelId: panel.id,
      extensionId,
      workspacePath,
      get theme() { return theme(); },
      getWorkspaceFolders: () => [workspacePath],
      getPrimaryFolderPath: () => workspacePath,
      onThemeChanged: (callback) => {
        const observer = new MutationObserver(() => callback(theme()));
        observer.observe(root, { attributeFilter: ['data-theme'] });
        return () => observer.disconnect();
      },
      openFile,
      openPanel,
      close,
      setGutterBadge: () => {},
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
  }, [close, extensionId, openFile, openPanel, openSession, panel.id, request, workspacePath]);

  if (error) return <p role="alert">{error}</p>;
  const Component = component;
  if (!Component) return <p role="status">Loading {panel.title}…</p>;
  return <section className="browser-host-native-panel" aria-label={panel.title}>
    <PanelBoundary><Component host={host} /></PanelBoundary>
  </section>;
}
