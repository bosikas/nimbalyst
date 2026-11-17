import React, { useEffect, useState } from 'react';
import type { BuiltInGuidanceEntry, BuiltInGuidanceId, BuiltInGuidanceSettings } from '@nimbalyst/runtime/ai/builtInGuidance';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';

export function BuiltInGuidancePanel() {
  const [entries, setEntries] = useState<BuiltInGuidanceEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string>();
  const [editing, setEditing] = useState<{ id: BuiltInGuidanceId; text: string }>();
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
  async function updateText(id: BuiltInGuidanceId, text: string | null) {
    setSaving(true);
    setError(undefined);
    try {
      setEntries(await window.electronAPI.agentGuidance.updateText(id, text));
      setEditing(undefined);
    } catch (err) { setError(`Could not save instructions: ${String(err)}`); }
    finally { setSaving(false); }
  }
  const filtered = entries.filter((entry) => `${entry.title} ${entry.description}`.toLowerCase().includes(query.toLowerCase()));
  const disabled = loading || saving || entries.length === 0;
  return (
    <section className="built-in-guidance-panel mb-4 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 select-text">
      <h5 className="text-sm font-semibold text-[var(--nim-text)]">Built-in skills &amp; guidance</h5>
      <p className="mt-1 text-xs leading-relaxed text-[var(--nim-text-muted)]">
        These are Nimbalyst’s built-in instructions, including commit proposals. Toggle or replace each section for all projects and providers that use it. Tools stay available.
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
          <div className="built-in-guidance-edit-actions mb-2 flex flex-wrap items-center gap-3 text-xs">
            <span className="text-[var(--nim-text-muted)]">{entry.customText === undefined ? 'Nimbalyst default' : 'Custom instructions'} · All projects</span>
            <button type="button" disabled={disabled || editing !== undefined} onClick={() => setEditing({ id: entry.id, text: entry.customText ?? entry.previews[0]?.text ?? '' })} className="text-[var(--nim-link)] disabled:opacity-50">Edit {entry.title}</button>
            {entry.customText !== undefined && <button type="button" disabled={disabled || (editing !== undefined && editing.id !== entry.id)} onClick={() => void updateText(entry.id, null)} className="text-[var(--nim-link)] disabled:opacity-50">Reset {entry.title} to default</button>}
          </div>
          {editing?.id === entry.id && <div className="built-in-guidance-editor mb-3">
            <p className="mb-2 text-xs text-[var(--nim-text-muted)]">This replacement applies to every provider variant of this section, only when the section applies. Saving preserves its enabled state.</p>
            <textarea aria-label={`Instructions for ${entry.title}`} value={editing.text} onChange={event => setEditing({ id: entry.id, text: event.target.value })} disabled={saving} rows={10} maxLength={100000} className="w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] p-2 font-mono text-xs text-[var(--nim-text)] select-text" />
            <div className="mt-2 flex gap-3 text-xs">
              <button type="button" disabled={saving || !editing.text.trim()} onClick={() => void updateText(entry.id, editing.text)} className="text-[var(--nim-link)] disabled:opacity-50">Save instructions</button>
              <button type="button" disabled={saving} onClick={() => setEditing(undefined)} className="text-[var(--nim-text-muted)]">Cancel</button>
            </div>
          </div>}
          {entry.customText !== undefined && <pre className="built-in-guidance-custom mb-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--nim-bg)] p-2 font-mono text-xs select-text">{entry.customText}</pre>}
          <details className="built-in-guidance-preview mb-2 text-xs text-[var(--nim-text-muted)]">
            <summary className="cursor-pointer">View default variants · Nimbalyst built-in</summary>
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
