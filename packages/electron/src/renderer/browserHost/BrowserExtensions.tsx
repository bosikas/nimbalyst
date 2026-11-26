import React, { useEffect, useState } from 'react';
import type { BrowserHostExtension, BrowserHostSchedule } from '../../shared/browserHost';

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

export function BrowserExtensions({ request, pdf }: { request: Request; pdf: React.ReactNode }) {
  const [view, setView] = useState(pdf ? 'pdf' : 'automations');
  const [installed, setInstalled] = useState<BrowserHostExtension[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void request('/extensions', { signal: controller.signal })
      .then((response) => response.json() as Promise<BrowserHostExtension[]>)
      .then(setInstalled)
      .catch((err: Error) => { if (!controller.signal.aborted) setError(err.message); });
    return () => controller.abort();
  }, [request]);

  return (
    <section className="browser-host-extension">
      <div className="browser-host-toolbar">
        <nav aria-label="Extension views">
          {pdf && <button type="button" aria-pressed={view === 'pdf'} onClick={() => setView('pdf')}>PDF Viewer</button>}
          <button type="button" aria-pressed={view === 'automations'} onClick={() => setView('automations')}>Automations</button>
          <button type="button" aria-pressed={view === 'installed'} onClick={() => setView('installed')}>Installed extensions</button>
        </nav>
      </div>
      {view === 'pdf' && pdf}
      {view === 'automations' && <Automations request={request} />}
      {view === 'installed' && (
        <section className="browser-host-automations" aria-label="Installed extensions">
          {error && <p role="status">{error}</p>}
          <ul>{installed.map((extension) => (
            <li key={extension.id}>{extension.name} {extension.version} · {extension.enabled ? 'Enabled' : 'Disabled'}</li>
          ))}</ul>
        </section>
      )}
    </section>
  );
}
