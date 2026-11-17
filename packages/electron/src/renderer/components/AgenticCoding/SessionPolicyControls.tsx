import React, { useEffect, useMemo, useState } from 'react';
import { atom, useAtomValue } from 'jotai';
import { FloatingPortal, FloatingOverlay, FloatingFocusManager, useFloating, useDismiss, useRole, useInteractions } from '@floating-ui/react';
import { sessionRegistryAtom } from '../../store/atoms/sessions';
import { readSessionPolicy, type SessionPolicy } from '@nimbalyst/runtime/ai/sessionPolicy';
import type { SessionInstructionOptions } from '@nimbalyst/runtime/ai/sessionInstructions';

export type SessionCreationValues = SessionPolicy & SessionInstructionOptions;

export function SessionPolicyFields({ value, onChange, disabled = false }: { value: SessionPolicy; onChange: (next: SessionPolicy) => void; disabled?: boolean }) {
  return <div className="session-policy-fields">
    <label className="session-custom-control"><span>Generate session summaries</span><input type="checkbox" checked={value.generateSummary} disabled={disabled} onChange={event => onChange({ ...value, generateSummary: event.target.checked })} /></label>
    <label className="session-custom-control"><span>Auto-archive after</span><span className="session-custom-number"><input aria-label="Auto-archive minutes" type="number" min={0} max={525600} step={1} value={value.autoArchiveAfterMinutes} disabled={disabled} onChange={event => { const n = event.currentTarget.valueAsNumber; if (Number.isSafeInteger(n) && n >= 0 && n <= 525600) onChange({ ...value, autoArchiveAfterMinutes: n }); }} /><span>min</span></span></label>
    <p className="session-custom-note">{value.autoArchiveAfterMinutes === 0 ? 'Auto-archive is off.' : `${value.autoArchiveAfterMinutes} idle minutes after a finished turn. Active work, pending input and selected chats stay visible. Transcripts and worktrees are retained.`}</p>
  </div>;
}

export function SessionPolicyEditor({ sessionId }: { sessionId: string }) {
  const stored = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)), [sessionId]));
  const [draft, setDraft] = useState(() => readSessionPolicy(stored));
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  useEffect(() => { setDraft(readSessionPolicy(stored)); }, [stored?.generateSummary, stored?.autoArchiveAfterMinutes]);
  if (stored?.remoteHostDeviceId || stored?.externalSource) return null;
  return <details className="session-policy-editor" onClick={event => event.stopPropagation()}><summary>Session settings</summary>
    <SessionPolicyFields value={draft} onChange={next => { setDraft(next); setState('idle'); }} disabled={state === 'saving'} />
    <button className="session-work-refresh" type="button" disabled={state === 'saving'} onClick={async () => {
      setState('saving');
      try {
        const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { metadata: draft });
        if (result?.success === false) throw new Error(result.error);
        setState('saved');
      } catch { setState('error'); }
    }}>{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save settings'}</button>
    {state === 'error' && <p role="alert">Could not save session settings.</p>}
  </details>;
}

export function SessionCreationOptions({ open, onClose, onCreate }: { open: boolean; onClose: () => void; onCreate: (policy: SessionCreationValues) => void | Promise<unknown> }) {
  const [policy, setPolicy] = useState<SessionPolicy>({ generateSummary: true, autoArchiveAfterMinutes: 0 });
  const [instructions, setInstructions] = useState<SessionInstructionOptions>({ instructionFile: '', skipDefaultInstructions: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const floating = useFloating({ open, onOpenChange: next => { if (!next && !busy) onClose(); } });
  const interactions = useInteractions([useDismiss(floating.context), useRole(floating.context, { role: 'dialog' })]);
  useEffect(() => { if (open) { setPolicy({ generateSummary: true, autoArchiveAfterMinutes: 0 }); setInstructions({ instructionFile: '', skipDefaultInstructions: false }); setError(''); } }, [open]);
  if (!open) return null;
  return <FloatingPortal><FloatingOverlay lockScroll className="session-custom-overlay"><FloatingFocusManager context={floating.context}>
    <section ref={floating.refs.setFloating} {...interactions.getFloatingProps()} className="session-customization session-creation-options" aria-label="New session options">
      <header><div><h2>New session</h2><p>Choose how this chat is maintained.</p></div><button type="button" aria-label="Close new session options" disabled={busy} onClick={onClose}>×</button></header>
      <div className="session-custom-controls">
        <label className="session-instruction-file"><span>Instruction file <small>optional</small></span><input type="text" value={instructions.instructionFile} disabled={busy} placeholder="profiles/reviewer.md or an absolute path" onChange={event => { const instructionFile = event.target.value; setInstructions(previous => ({ ...previous, instructionFile, skipDefaultInstructions: !previous.instructionFile?.trim() && instructionFile.trim() ? true : previous.skipDefaultInstructions })); }} /></label>
        <label className="session-custom-control"><span>Skip default instruction files</span><input type="checkbox" checked={instructions.skipDefaultInstructions} disabled={busy} onChange={event => setInstructions(previous => ({ ...previous, skipDefaultInstructions: event.target.checked }))} /></label>
        <p className="session-custom-note">Codex: AGENTS.md. Claude Agent: CLAUDE.md and rules. The selected Markdown file is saved with this session (24 KB maximum); relative paths use the project folder. System guidance and managed policies still apply.</p>
        <SessionPolicyFields value={policy} onChange={setPolicy} disabled={busy} /><p className="session-custom-note">Uses your currently selected model. Review workers can turn summaries off and use a 30-minute archive timer.</p>
      </div>
      {error && <p role="alert" className="session-custom-error">{error}</p>}
      <footer><button type="button" onClick={onClose} disabled={busy}>Cancel</button><button type="button" disabled={busy} onClick={async () => { setBusy(true); setError(''); try { await onCreate({ ...policy, ...instructions }); onClose(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not create the session.'); } finally { setBusy(false); } }}>{busy ? 'Creating…' : 'Create session'}</button></footer>
    </section>
  </FloatingFocusManager></FloatingOverlay></FloatingPortal>;
}
