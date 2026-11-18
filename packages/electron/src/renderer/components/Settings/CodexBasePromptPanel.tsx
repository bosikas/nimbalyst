import React, { useEffect, useState } from 'react';
import type { CodexBaseInstructionsSource } from '@nimbalyst/runtime/ai/builtInGuidance';
import { chooseMarkdownFile } from './BuiltInGuidancePanel';

/**
 * The Codex base prompt is provider-owned by default and is not shown or copied here.
 * A custom base is a Markdown file that replaces it for fresh native threads only.
 */
export function CodexBasePromptPanel() {
  const [source, setSource] = useState<CodexBaseInstructionsSource>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState<string>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    window.electronAPI.agentGuidance.getCodexBase().then(
      value => { if (!cancelled) { setSource(value); setError(undefined); } },
      err => { if (!cancelled) setError(String(err)); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [revision]);

  async function run(action: () => Promise<CodexBaseInstructionsSource>, failure: string, onSuccess?: () => void) {
    setSaving(true);
    setError(undefined);
    try {
      setSource(await action());
      onSuccess?.();
    } catch (err) { setError(`${failure}: ${String(err)}`); }
    finally { setSaving(false); }
  }
  async function choose() {
    let filePath: string | undefined;
    try { filePath = await chooseMarkdownFile('Markdown base prompt for Codex'); }
    catch (err) { setError(`Could not open the file picker: ${String(err)}`); return; }
    if (filePath) await run(() => window.electronAPI.agentGuidance.selectCodexBaseSource(filePath!), `Could not use ${filePath}`);
  }
  const busy = loading || saving;
  const custom = Boolean(source.sourcePath);
  return (
    <section className="codex-base-prompt-panel mb-4 rounded border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] p-3 select-text">
      <h5 className="text-sm font-semibold text-[var(--nim-text)]">Codex base prompt</h5>
      <p className="mt-1 text-xs leading-relaxed text-[var(--nim-text-muted)]">
        By default Codex uses its own provider-owned base prompt, which Nimbalyst does not show or modify. A custom base replaces it with a Markdown file you control.
        It applies only when Nimbalyst starts a fresh native Codex thread; resumed threads keep the base they started with. Nimbalyst guidance above is added separately as developer instructions.
      </p>
      <div className="codex-base-prompt-status my-2 flex flex-wrap items-center gap-3 text-xs">
        <span className="text-[var(--nim-text-muted)]">{custom ? 'Custom Markdown file' : 'Provider default (owned by Codex)'} · All projects</span>
        <button type="button" disabled={busy || draft !== undefined} onClick={() => setDraft(source.text ?? '')} className="text-[var(--nim-link)] disabled:opacity-50">{custom ? 'Edit Codex base prompt' : 'Write custom Codex base prompt'}</button>
        <button type="button" disabled={busy || draft !== undefined} onClick={() => void choose()} className="text-[var(--nim-link)] disabled:opacity-50">Choose Markdown file for Codex base prompt</button>
        <button type="button" disabled={busy} onClick={() => setRevision(value => value + 1)} className="text-[var(--nim-link)] disabled:opacity-50">Reload Codex base prompt</button>
        {custom && <button type="button" disabled={busy || draft !== undefined} onClick={() => void run(() => window.electronAPI.agentGuidance.updateCodexBase(null), 'Could not reset the Codex base prompt')} className="text-[var(--nim-link)] disabled:opacity-50">Reset Codex base prompt to provider default</button>}
      </div>
      {loading && <p role="status" className="text-xs text-[var(--nim-text-muted)]">Loading Codex base prompt…</p>}
      {error && <p role="alert" className="text-xs text-[var(--nim-error)]">{error}</p>}
      {source.sourcePath && <p className="codex-base-prompt-source mb-2 break-all text-xs text-[var(--nim-text-muted)]">Source: <span className="font-mono">{source.sourcePath}</span></p>}
      {source.error && <p role="alert" className="codex-base-prompt-source-error mb-2 break-words text-xs text-[var(--nim-error)]">Cannot read this file: {source.error}. New Codex threads fail instead of using the provider default. Fix the file, choose another, or reset.</p>}
      {draft !== undefined && <div className="codex-base-prompt-editor mb-3">
        <p className="mb-2 text-xs text-[var(--nim-text-muted)]">Write the complete base prompt. Saving writes a new Markdown file and keeps any previous one.</p>
        <textarea aria-label="Codex base prompt" value={draft} onChange={event => setDraft(event.target.value)} disabled={saving} rows={14} placeholder="Complete base instructions for fresh Codex threads"
          className="w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] p-2 font-mono text-xs text-[var(--nim-text)] select-text" />
        <div className="mt-2 flex gap-3 text-xs">
          <button type="button" disabled={saving || !draft.trim()} onClick={() => void run(() => window.electronAPI.agentGuidance.updateCodexBase(draft), 'Could not save the Codex base prompt', () => setDraft(undefined))} className="text-[var(--nim-link)] disabled:opacity-50">Save Codex base prompt</button>
          <button type="button" disabled={saving} onClick={() => setDraft(undefined)} className="text-[var(--nim-text-muted)]">Cancel</button>
        </div>
      </div>}
      {source.text !== undefined && draft === undefined && <details className="codex-base-prompt-preview text-xs">
        <summary className="cursor-pointer text-[var(--nim-text-muted)]">View custom Codex base prompt</summary>
        <pre aria-label="Custom Codex base prompt" className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--nim-bg)] p-2 font-mono select-text">{source.text}</pre>
      </details>}
    </section>
  );
}
