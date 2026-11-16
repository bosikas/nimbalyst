import React, { useEffect, useRef, useState } from 'react';
import type { CodexSkillCatalog } from '../../../shared/codexSkills';
import { SettingsToggle } from '../GlobalSettings/SettingsToggle';

export function InstalledSkillsPanel({ workspacePath }: { workspacePath: string | null }) {
  const [catalog, setCatalog] = useState<CodexSkillCatalog | null>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const generation = useRef(0);
  const inFlight = useRef(0);
  useEffect(() => { generation.current++; inFlight.current = 0; setCatalog(null); setPreviews({}); setError(undefined); setBusy(false); }, [workspacePath]);

  async function run(operation: (workspace: string) => Promise<void>) {
    if (!workspacePath) return;
    const current = generation.current;
    inFlight.current++; setBusy(true); setError(undefined);
    try { await operation(workspacePath); }
    catch (err) { if (generation.current === current) setError(String(err)); }
    finally { if (generation.current === current) { inFlight.current--; setBusy(inFlight.current > 0); } }
  }
  async function load() {
    const current = generation.current;
    await run(async workspace => {
      const result = await window.electronAPI.agentGuidance.listSkills(workspace);
      if (generation.current === current) setCatalog(result);
    });
  }
  const entries = catalog?.skills.filter(skill => `${skill.name} ${skill.description} ${skill.path} ${skill.scope}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  return <section className="installed-skills-panel mb-4 rounded border border-[var(--nim-border)] p-3 select-text">
    <div className="flex items-center justify-between gap-2">
      <h5 className="text-sm font-semibold">Installed Codex skills</h5>
      <button type="button" disabled={busy || !workspacePath} onClick={() => void load()} className="text-xs text-[var(--nim-link)] disabled:opacity-50">{busy ? 'Working…' : catalog ? 'Refresh' : 'Load skills'}</button>
    </div>
    <p className="mt-1 text-xs text-[var(--nim-text-muted)]">Native Codex discovery, including disabled skills. Switches save to your Codex user configuration and affect this skill path across projects. Existing thread history keeps earlier instructions; use a fresh session after changing skills. Claude skills remain managed by their provider or extension.</p>
    {!workspacePath && <p role="status" className="mt-2 text-xs">Open a workspace to inspect its skills.</p>}
    {error && <p role="alert" className="mt-2 text-xs text-[var(--nim-error)]">{error}</p>}
    {catalog && <>
      <input aria-label="Search installed skills" placeholder="Search name, source or instructions description…" value={query} onChange={event => setQuery(event.target.value)} className="my-2 w-full rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1 text-sm" />
      {catalog.errors.map((entry, index) => <p key={index} role="status" className="text-xs text-[var(--nim-warning)]">{entry.path}: {entry.message}</p>)}
      {!entries.length && <p className="text-xs text-[var(--nim-text-muted)]">No matching skills reported by Codex.</p>}
      {entries.map(skill => <div key={skill.path} className="installed-skill-entry border-t border-[var(--nim-border)]">
        <SettingsToggle name={skill.name} description={skill.description} checked={skill.enabled} disabled={busy || !/^(\/|[A-Za-z]:[\\/])/.test(skill.path)} onChange={enabled => {
          const current = generation.current;
          void run(async workspace => {
            const result = await window.electronAPI.agentGuidance.setSkillEnabled(workspace, skill.path, enabled);
            if (generation.current === current) setCatalog(result);
          });
        }} />
        <p className="mb-2 break-all text-xs text-[var(--nim-text-muted)]">{skill.scope}{skill.pluginId ? ` · ${skill.pluginId}` : ''} · {skill.path}</p>
        {!/^(\/|[A-Za-z]:[\\/])/.test(skill.path) && <p className="mb-2 text-xs text-[var(--nim-text-muted)]">This native source has no local path. Path-based switches and file previews are unavailable.</p>}
        <details className="installed-skill-preview mb-2 text-xs" onToggle={event => {
          if (!event.currentTarget.open || previews[skill.path] !== undefined) return;
          const current = generation.current;
          void run(async workspace => {
            const text = await window.electronAPI.agentGuidance.previewSkill(workspace, skill.path);
            if (generation.current === current) setPreviews(value => ({ ...value, [skill.path]: text }));
          });
        }}>
          <summary className="cursor-pointer text-[var(--nim-text-muted)]">View instructions</summary>
          <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--nim-bg-secondary)] p-2 select-text">{previews[skill.path] ?? (busy ? 'Loading preview…' : 'Preview unavailable. See the error above or open the source path. Close and reopen to retry.')}</pre>
        </details>
      </div>)}
    </>}
  </section>;
}
