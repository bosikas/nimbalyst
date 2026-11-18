import React, { useEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import type { AgentGuidancePreview, AgentSetupProvider } from '@nimbalyst/runtime/ai/builtInGuidance';
import { activeSessionIdAtom, sessionPromptAdditionsAtom } from '../../store/atoms/sessions';
import { navigateSettingsInPlaceAtom } from '../../store/atoms/settingsNavigation';
import type { SettingsCategory } from './SettingsSidebar';
import { BuiltInGuidancePanel } from './BuiltInGuidancePanel';
import { CodexBasePromptPanel } from './CodexBasePromptPanel';
import { InstalledSkillsPanel } from './InstalledSkillsPanel';
import { ToolsMcpPanel } from './panels/ToolsMcpPanel';
import { ProjectPermissionsPanel } from './panels/ProjectPermissionsPanel';
import './AgentSetupPanel.css';

const TABS = [
  ['instructions', 'Instructions'],
  ['tools', 'Tools'],
  ['environment', 'Environment'],
  ['effective', 'Effective setup'],
] as const;
type SetupTab = typeof TABS[number][0];

function CapturedPromptAdditions({ sessionId }: { sessionId: string }) {
  const captured = useAtomValue(sessionPromptAdditionsAtom(sessionId));
  return <section className="agent-setup-capture mt-5 border-t border-[var(--nim-border)] pt-4">
    <h6 className="text-sm font-semibold">Latest captured prompt additions</h6>
    <p className="my-2 text-xs text-[var(--nim-text-muted)]">Session {sessionId}. Captured while this app window was open; this is the latest prepared turn, not a full initial request or proof of native delivery. Provider instructions, repository rules, skills and loaded tool schemas are unavailable here.</p>
    {!captured ? <p className="text-xs text-[var(--nim-text-muted)]">No prompt additions captured for this session in this window yet.</p> : <>
      <p className="mb-2 text-xs text-[var(--nim-text-muted)]">Captured {new Date(captured.timestamp).toLocaleString()}. Saved configuration changes do not alter this capture.</p>
      <details className="agent-setup-captured-system mb-2" open>
        <summary className="cursor-pointer text-xs">Nimbalyst system / developer additions</summary>
        <pre className="agent-setup-prompt">{captured.systemPromptAddition ?? 'No system additions.'}</pre>
      </details>
      <details className="agent-setup-captured-context mb-2">
        <summary className="cursor-pointer text-xs">User message additions and attachments</summary>
        <pre className="agent-setup-prompt">{captured.userMessageAddition ?? 'No user message additions.'}</pre>
        {captured.attachments?.map((attachment, index) => <p key={index} className="text-xs break-all">{attachment.filename} · {attachment.type}{attachment.mimeType ? ` · ${attachment.mimeType}` : ''}</p>)}
      </details>
    </>}
  </section>;
}

function EffectiveSetupPanel({ workspacePath }: { workspacePath: string | null }) {
  const [provider, setProvider] = useState<AgentSetupProvider>('openai-codex');
  const [preview, setPreview] = useState<AgentGuidancePreview>();
  const [error, setError] = useState<string>();
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);
  const sessionId = useAtomValue(activeSessionIdAtom);
  useEffect(() => {
    let cancelled = false;
    setPreview(undefined);
    setError(undefined);
    if (!workspacePath) { setLoading(false); return; }
    setLoading(true);
    window.electronAPI.agentGuidance.preview(workspacePath, provider).then(
      value => { if (!cancelled) setPreview(value); },
      err => { if (!cancelled) setError(String(err)); },
    ).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspacePath, provider, revision]);
  return <div className="agent-setup-effective">
    <h5 className="text-sm font-semibold">Resolved guidance preview</h5>
    <p className="my-2 text-xs text-[var(--nim-text-muted)]">Build the Nimbalyst-owned instructions using your saved settings and the selected provider. This preview covers a baseline session; captured additions below show a prepared turn.</p>
    <div className="agent-setup-preview-controls mb-3 flex flex-wrap items-center gap-3">
      <label className="text-xs">Provider <select aria-label="Guidance preview provider" value={provider} onChange={event => setProvider(event.target.value as AgentSetupProvider)} className="ml-2 rounded border border-[var(--nim-border)] bg-[var(--nim-bg)] px-2 py-1">
        <option value="openai-codex">Codex</option>
        <option value="claude-code">Claude Agent</option>
      </select></label>
      <button type="button" disabled={loading || !workspacePath} onClick={() => setRevision(value => value + 1)} className="text-xs text-[var(--nim-link)] disabled:opacity-50">Refresh preview</button>
    </div>
    {!workspacePath && <p role="status" className="text-xs">Open a workspace to resolve its guidance.</p>}
    {loading && <p role="status" className="text-xs">Building guidance…</p>}
    {error && <p role="alert" className="text-xs text-[var(--nim-error)]">{error}</p>}
    {preview && <>
      <p className="mb-2 break-all text-xs text-[var(--nim-text-muted)]">{workspacePath} · {preview.role}</p>
      <p className="mb-2 text-xs text-[var(--nim-text-muted)]">{preview.scope}</p>
      <pre aria-label="Resolved Nimbalyst guidance" className="agent-setup-prompt">{preview.text || 'No Nimbalyst guidance enabled for this baseline.'}</pre>
      {preview.provider === 'openai-codex' && (preview.baseInstructions ? <details className="agent-setup-codex-base mt-3">
        <summary className="cursor-pointer text-xs">Custom Codex base prompt</summary>
        <p className="my-2 break-all text-xs text-[var(--nim-text-muted)]">{preview.baseInstructions.sourcePath} · {preview.baseInstructions.scope}</p>
        <pre aria-label="Resolved Codex base prompt" className="agent-setup-prompt">{preview.baseInstructions.text}</pre>
      </details> : <p className="mt-3 text-xs text-[var(--nim-text-muted)]">Codex base prompt: provider default (owned by Codex, not shown).</p>)}
    </>}
    {sessionId ? <CapturedPromptAdditions sessionId={sessionId} /> : <p className="mt-4 text-xs text-[var(--nim-text-muted)]">Select a session to inspect its captured prompt additions.</p>}
  </div>;
}

export function AgentSetupPanel({ workspacePath, children }: { workspacePath: string | null; children?: React.ReactNode }) {
  const [tab, setTab] = useState<SetupTab>('instructions');
  const navigateInPlace = useSetAtom(navigateSettingsInPlaceAtom);
  const navigate = (category: string) => navigateInPlace({ category: category as SettingsCategory, scope: category.startsWith('project-') ? 'project' : 'application' });
  return <section className="agent-setup-panel mb-5 select-text">
    <div className="agent-setup-heading mb-3">
      <h4 className="text-base font-semibold">Agent setup</h4>
      <p className="mt-1 text-xs text-[var(--nim-text-muted)]">Inspect and configure the instructions, tools and access your agents receive. Guidance defaults apply across projects; access is configured per workspace. Use a new session after changes to avoid instructions retained in earlier history.</p>
    </div>
    <div role="tablist" aria-label="Agent setup" className="agent-setup-tabs mb-4 flex flex-wrap gap-1 border-b border-[var(--nim-border)]">
      {TABS.map(([id, label], index) => <button key={id} type="button" role="tab" id={`agent-setup-tab-${id}`} aria-selected={tab === id} aria-controls={`agent-setup-content-${id}`} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % TABS.length : event.key === 'ArrowLeft' ? (index + TABS.length - 1) % TABS.length : event.key === 'Home' ? 0 : event.key === 'End' ? TABS.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        setTab(TABS[next][0]);
        document.getElementById(`agent-setup-tab-${TABS[next][0]}`)?.focus();
      }} className="agent-setup-tab rounded-t px-3 py-2 text-xs">{label}</button>)}
    </div>
    <div role="tabpanel" id="agent-setup-content-instructions" aria-labelledby="agent-setup-tab-instructions" hidden={tab !== 'instructions'}>
      <BuiltInGuidancePanel />
      <CodexBasePromptPanel />
      <InstalledSkillsPanel workspacePath={workspacePath} />
      {children}
    </div>
    {tab === 'tools' && <div role="tabpanel" id="agent-setup-content-tools" aria-labelledby="agent-setup-tab-tools">
      <p className="mb-3 text-xs text-[var(--nim-text-muted)]">Tool availability and permission to execute are separate. Inspect tool schemas here; configure execution access under Environment. Native built-in tools and external server schemas are controlled by their provider.</p>
      <ToolsMcpPanel workspacePath={workspacePath ?? undefined} onNavigateToCategory={navigate} />
    </div>}
    {tab === 'environment' && <div role="tabpanel" id="agent-setup-content-environment" aria-labelledby="agent-setup-tab-environment">
      <p className="mb-3 text-xs text-[var(--nim-text-muted)]">Model and reasoning are selected per session. Provider settings configure defaults; workspace permissions below control execution access.</p>
      <div className="agent-setup-provider-links mb-4 flex flex-wrap gap-3 text-xs">
        <button type="button" onClick={() => navigate('claude-code')} className="text-[var(--nim-link)]">Claude Agent settings</button>
        <button type="button" onClick={() => navigate('openai-codex')} className="text-[var(--nim-link)]">Codex settings</button>
      </div>
      {workspacePath ? <>
        <p className="mb-3 break-all text-xs text-[var(--nim-text-muted)]">Workspace: {workspacePath}. Sessions in worktrees use their assigned working directory.</p>
        <ProjectPermissionsPanel workspacePath={workspacePath} workspaceName="this workspace" />
      </> : <p className="text-xs text-[var(--nim-text-muted)]">Open a workspace to configure agent access.</p>}
    </div>}
    {tab === 'effective' && <div role="tabpanel" id="agent-setup-content-effective" aria-labelledby="agent-setup-tab-effective"><EffectiveSetupPanel workspacePath={workspacePath} /></div>}
  </section>;
}
