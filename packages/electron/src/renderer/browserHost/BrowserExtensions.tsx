import React, { useCallback, useEffect, useState } from 'react';
import type { PanelHostComponents } from '@nimbalyst/extension-sdk';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import type { BrowserHostExtension, BrowserHostSchedule } from '../../shared/browserHost';
import { BrowserPanel, type RegisterBrowserPanelBridge } from './BrowserPanel';
import { BrowserUsageIndicators, useBrowserRailStatus } from './BrowserRailStatus';
import { PanelGutterBadgeBubble } from '../extensions/panels/PanelGutterBadgeBubble';
import { downloadBrowserFile } from './downloadBrowserFile';

type Request = (path: string, init?: RequestInit) => Promise<Response>;
const week = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

function Automations({ request }: { request: Request }) {
  const [schedule, setSchedule] = useState<BrowserHostSchedule['type']>('daily');
  const [automations, setAutomations] = useState('');
  const [feedback, setFeedback] = useState('');
  const [saving, setSaving] = useState(false);

  async function load() {
    const response = await request('/automations');
    return (await response.json() as { text: string }).text;
  }

  useEffect(() => {
    let active = true;
    void load().then((text) => {
      if (active) setAutomations(text);
    }).catch((error: Error) => {
      if (active) setFeedback(error.message);
    });
    return () => { active = false; };
  }, [request]);

  async function create(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const fields = new FormData(form);
    setSaving(true);
    setFeedback('');
    try {
      await request('/automations', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          title: fields.get('title'),
          prompt: fields.get('prompt'),
          type: schedule,
          time: fields.get('time'),
          days: fields.getAll('days'),
          minutes: Number(fields.get('minutes')),
        }),
      });
      form.reset();
      setFeedback('Automation scheduled');
      void load().then(setAutomations).catch(() => {
        setFeedback('Automation scheduled. Reopen Automations to refresh the list.');
      });
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not schedule automation');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="browser-host-automations" aria-label="Automations">
      <form onSubmit={(event) => void create(event)}>
        <label>Name<input name="title" required maxLength={120} /></label>
        <label>Prompt<textarea name="prompt" required maxLength={32000} /></label>
        <label>Schedule<select value={schedule} onChange={(event) =>
          setSchedule(event.target.value as BrowserHostSchedule['type'])}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="interval">Interval</option>
        </select></label>
        {schedule === 'interval'
          ? <label>Minutes<input name="minutes" type="number" min={1} max={10080} required /></label>
          : <label>Time on the Linux host<input name="time" type="time" required /></label>}
        {schedule === 'weekly' && (
          <fieldset><legend>Days</legend>{week.map((day) =>
            <label key={day}><input name="days" type="checkbox" value={day} /> {day}</label>
          )}</fieldset>
        )}
        <button type="submit" disabled={saving}>Schedule automation</button>
      </form>
      {feedback && <p role="status">{feedback}</p>}
      {automations && <pre>{automations}</pre>}
    </section>
  );
}

export function BrowserWorkspaceViews({ request, pdf, pdfName, workspacePath, openSession, components, registerPanelBridge, connectionControl, children }:
  { request: Request; pdf: React.ReactNode; pdfName: string | null; workspacePath: string;
    openSession: (id: string) => void; components?: PanelHostComponents; registerPanelBridge?: RegisterBrowserPanelBridge;
    connectionControl?: React.ReactNode; children: React.ReactNode }) {
  const [view, setView] = useState('sessions');
  const [installed, setInstalled] = useState<BrowserHostExtension[]>([]);
  const [error, setError] = useState('');
  const [navigationError, setNavigationError] = useState('');
  const refreshRailUsage = useBrowserRailStatus(request);
  useEffect(() => {
    const controller = new AbortController();
    void request('/extensions', { signal: controller.signal })
      .then((response) => response.json() as Promise<BrowserHostExtension[]>)
      .then(setInstalled)
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [request]);

  const panels = installed.flatMap((extension) =>
    (extension.panels ?? []).map((panel) => ({ extensionId: extension.id, panel, viewId: `${extension.id}/${panel.id}` })),
  ).sort((a, b) => (a.panel.order ?? 100) - (b.panel.order ?? 100));
  const active = panels.find(({ viewId }) => view === viewId);
  const goToSession = useCallback((id: string) => {
    openSession(id);
    setView('sessions');
  }, [openSession]);
  const openPanel = useCallback((id: string) => {
    const extension = installed.find((entry) => entry.panels?.some((panel) => panel.id === id));
    if (extension) setView(`${extension.id}/${id}`);
    else setNavigationError('Extension panel is unavailable');
  }, [installed]);
  const openFile = useCallback((path: string) => {
    if (path.startsWith('session://')) goToSession(path.slice('session://'.length).split('/')[0]);
    else if (pdfName && path === `${workspacePath}/${pdfName}`) setView('pdf');
    else {
      setNavigationError('');
      const filePath = path.startsWith('/') ? path : `${workspacePath}/${path}`;
      void downloadBrowserFile(request, filePath).catch((error: Error) => setNavigationError(error.message));
    }
  }, [goToSession, pdfName, request, workspacePath]);
  const close = useCallback(() => setView('sessions'), []);
  useEffect(() => setNavigationError(''), [view]);

  function railButton(id: string, label: string, icon: string, panelId?: string) {
    const active = view === id;
    return (
      <button key={id} type="button" title={label} aria-label={label} aria-pressed={active}
        onClick={() => setView(active ? 'sessions' : id)}>
        <MaterialSymbol icon={icon} size={20} fill={active} />
        {panelId && <PanelGutterBadgeBubble panelId={panelId} />}
      </button>
    );
  }

  return (
    <div className="browser-host-layout">
      <nav className="browser-host-rail" aria-label="Workspace views">
        {railButton('sessions', 'Sessions', 'forum')}
        {panels.map(({ extensionId, viewId, panel }) =>
          railButton(viewId, panel.title, panel.icon || 'extension', `${extensionId}.${panel.id}`))}
        {pdf && railButton('pdf', 'PDF Viewer', 'picture_as_pdf')}
        {railButton('automations', 'Automations', 'schedule')}
        {railButton('installed', 'Installed extensions', 'extension')}
        {connectionControl}
        <BrowserUsageIndicators refresh={refreshRailUsage} />
      </nav>
      <section className="browser-host-extension">
        {view === 'sessions' && children}
        {view === 'pdf' && pdf}
        {view === 'automations' && <Automations request={request} />}
        {navigationError && <p role="alert">{navigationError}</p>}
        {active && <BrowserPanel key={view} request={request} extensionId={active.extensionId}
          panel={active.panel} workspacePath={workspacePath} openPanel={openPanel}
          close={close} openFile={openFile} openSession={goToSession} components={components}
          registerBridge={registerPanelBridge} />}
        {view === 'installed' && (
          <section className="browser-host-automations" aria-label="Installed extensions">
            {error && <p role="status">{error}</p>}
            <ul>{installed.map((extension) => (
              <li key={extension.id}>
                {extension.name} {extension.version} · {extension.enabled ? 'Enabled' : 'Disabled'}
                {extension.panels?.map((panel) => (
                  <button key={panel.id} type="button" onClick={() => setView(`${extension.id}/${panel.id}`)}>
                    Open {panel.title}
                  </button>
                ))}
              </li>
            ))}</ul>
          </section>
        )}
      </section>
    </div>
  );
}
