import React, { useEffect, useState } from 'react';
import type { BuiltInGuidanceEntry, BuiltInGuidanceSettings } from '@nimbalyst/runtime/ai/builtInGuidance';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';

export function BuiltInGuidancePanel() {
  const [entries, setEntries] = useState<BuiltInGuidanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.agentGuidance.getCatalog().then(
      (catalog) => { if (!cancelled) setEntries(catalog); },
      (err) => { if (!cancelled) setError(String(err)); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function update(settings: BuiltInGuidanceSettings) {
    setSaving(true);
    setError(undefined);
    try { setEntries(await window.electronAPI.agentGuidance.update(settings)); }
    catch (err) { setError(`Could not save guidance settings: ${String(err)}`); }
    finally { setSaving(false); }
  }
  const filtered = entries.filter((entry) => `${entry.title} ${entry.description}`.toLowerCase().includes(query.toLowerCase()));
  const disabled = loading || saving || entries.length === 0;
  return (
    <section className="built-in-guidance-panel mb-4 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 select-text">
      <h5 className="text-sm font-semibold text-[var(--nim-text)]">Built-in skills &amp; guidance</h5>
      <p className="mt-1 text-xs leading-relaxed text-[var(--nim-text-muted)]">
        These are Nimbalyst’s built-in instructions, including commit proposals. Toggle them for all projects and providers that use them. Tools stay available.
        Changes apply to future prompts. Start a fresh session to avoid instructions retained in earlier history.
        Repository instructions and provider-owned skills are separate; installed skills are managed in Extensions and the source controls below.
      </p>
      <div className="built-in-guidance-actions my-2 flex flex-wrap items-center gap-2">
        <input aria-label="Search built-in guidance" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search built-in guidance…"
          className="min-w-0 flex-1 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-sm text-[var(--nim-text)]" />
        <button type="button" disabled={disabled} onClick={() => void update(Object.fromEntries(entries.map(({ id }) => [id, true])))} className="text-xs text-[var(--nim-link)] disabled:opacity-50">Enable all</button>
        <button type="button" disabled={disabled} onClick={() => void update(Object.fromEntries(entries.map(({ id }) => [id, false])))} className="text-xs text-[var(--nim-link)] disabled:opacity-50">Disable all</button>
      </div>
      {loading && <p role="status" className="text-xs text-[var(--nim-text-muted)]">Loading built-in guidance…</p>}
      {error && <p role="alert" className="text-xs text-[var(--nim-error)]">{error}</p>}
      {!loading && !filtered.length && <p className="text-xs text-[var(--nim-text-muted)]">No matching guidance.</p>}
      {filtered.map((entry) => (
        <div key={entry.id} className="built-in-guidance-entry border-t border-[var(--nim-border)]">
          <SettingsToggle name={entry.title} description={entry.description} checked={entry.enabled} disabled={disabled} onChange={(enabled) => void update({ [entry.id]: enabled })} />
          <details className="built-in-guidance-preview mb-2 text-xs text-[var(--nim-text-muted)]">
            <summary className="cursor-pointer">View instructions · Nimbalyst built-in</summary>
            <p className="mt-1">Examples from the active prompt builders. Conditional sections appear only when applicable.</p>
            {entry.previews.map((preview, index) => (
              <div key={`${preview.provider}-${index}`} className="built-in-guidance-variant mt-2">
                <h6 className="font-semibold">{preview.provider}</h6>
                <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--nim-bg)] p-2 font-mono select-text">{preview.text}</pre>
              </div>
            ))}
          </details>
        </div>
      ))}
    </section>
  );
}
