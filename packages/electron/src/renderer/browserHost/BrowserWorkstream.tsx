import React, { useEffect, useLayoutEffect, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { WorkstreamHeader } from '../components/AgentMode/WorkstreamHeader';
import { SessionTabBar } from '../components/AgentMode/WorkstreamSessionTabs';
import { activeSessionIdAtom, sessionRegistryAtom, updateSessionStoreAtom, workstreamSessionsAtom } from '../store/atoms/sessions';
import { setWorktreeRecordAtom, type WorktreeRecord } from '../store/atoms/worktrees';

interface Props {
  workstreamId: string;
  selected: string;
  onSelect: (id: string) => void;
  onCommand: (channel: string, ...args: unknown[]) => Promise<unknown>;
  renderSession: (id: string) => React.ReactNode;
}

export default function BrowserWorkstream({ workstreamId, selected, onSelect, onCommand, renderSession }: Props) {
  const registry = useAtomValue(sessionRegistryAtom);
  const worktreeId = registry.get(workstreamId)?.worktreeId;
  const tabs = useAtomValue(workstreamSessionsAtom(workstreamId));
  const updateSession = useSetAtom(updateSessionStoreAtom);
  const setActiveSession = useSetAtom(activeSessionIdAtom);
  const setWorktree = useSetAtom(setWorktreeRecordAtom);
  const [feedback, setFeedback] = useState('');
  const [creating, setCreating] = useState(false);
  const active = registry.get(selected)?.sessionType === 'workstream' ? tabs[0] ?? null : selected;
  const visibleTabs = active && !tabs.includes(active) ? [active, ...tabs] : tabs;

  useLayoutEffect(() => setActiveSession(active), [active, setActiveSession]);

  useEffect(() => {
    if (!worktreeId) return;
    let disposed = false;
    void onCommand('worktree:get-batch', [worktreeId]).then((response) => {
      const record = (response as { worktrees?: Record<string, WorktreeRecord> }).worktrees?.[worktreeId];
      if (!disposed && record) setWorktree({ ...record, isPinned: record.isPinned ?? false });
    }).catch((error: Error) => {
      if (!disposed) setFeedback(error.message);
    });
    return () => { disposed = true; };
  }, [worktreeId, onCommand, setWorktree]);

  async function update(id: string, updates: { title: string } | { isArchived: boolean }) {
    try {
      await onCommand('sessions:update-metadata', id, updates);
      updateSession({ sessionId: id, updates });
      setFeedback('');
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Session action failed');
    }
  }

  async function createTab() {
    setCreating(true);
    try {
      const { sessionId } = await onCommand('sessions:create-child', workstreamId) as { sessionId: string };
      setFeedback('');
      onSelect(sessionId);
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Could not create session');
    } finally {
      setCreating(false);
    }
  }

  return (
    <section className="browser-host-workstream workstream-session-tabs flex min-h-0 flex-col overflow-hidden">
      <WorkstreamHeader workstreamId={workstreamId} activeSessionId={active} worktreeId={worktreeId}
        onOpenSession={onSelect} archiveDisabled={Boolean(worktreeId)} />
      <SessionTabBar sessions={visibleTabs} activeSessionId={active} onSessionSelect={onSelect}
        onNewSession={() => void createTab()} creatingSession={creating}
        onSessionRename={(id, title) => void update(id, { title })}
        onSessionArchive={(id) => void update(id, { isArchived: true })}
        onSessionUnarchive={(id) => void update(id, { isArchived: false })} />
      {feedback && <p className="browser-host-history-error" role="alert">{feedback}</p>}
      {active && renderSession(active)}
    </section>
  );
}
