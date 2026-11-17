import { SessionSpawnerLink } from './SessionSpawnerLink';
import { SessionProviderIcon } from './SessionProviderIcon';
import { SessionContextUsageBar } from './SessionContextUsageBar';
import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react';
import { autoUpdate, flip, FloatingFocusManager, FloatingPortal, offset, safePolygon, shift, useDismiss, useFloating, useFocus, useHover, useInteractions, useRole } from '@floating-ui/react';
import { atom, useAtomValue, useSetAtom } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import { invalidateSessionMoveUndo, useSessionTreeMove } from './useSessionTreeMove';
import { SessionMovePicker } from './SessionMovePicker';
import { WorktreeIcon } from '../common/WorktreeIcon';
import { ProviderIcon } from '@nimbalyst/runtime/ui/icons/ProviderIcons';
import { getRelativeTimeString } from '../../utils/dateFormatting';
import { sessionOrChildProcessingAtom, sessionUnreadAtom, sessionPendingPromptAtom, sessionHasPendingInteractivePromptAtom, sessionShareAtom, sessionWakeupAtom, sessionLastActivityAtom } from '../../store';
import { sessionRegistryAtom, pendingSessionRenameAtom, createWorkstreamAtom } from '../../store/atoms/sessions';
import { SessionWorkCaption, SessionWorkSummaryDetails, SessionWorkAttentionIndicator } from './SessionWorkCaption';
import { SessionContextMenu } from './SessionContextMenu';
import { errorNotificationService } from '../../services/ErrorNotificationService';
import { FullTitleTooltip } from './FullTitleTooltip';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { sessionAppearanceVariables } from '../../../shared/sessionListAppearance';
import { sessionAgentWakePendingAtom } from '../../store/atoms/teamInbox';
import { sessionBackgroundTasksAtom, describeBackgroundWait } from '../../store/atoms/sessionBackgroundTasks';

/**
 * Combined status indicator that subscribes to this session's state atoms.
 * Shows waiting for input, processing, pending prompt, or unread status (in priority order).
 * Only this component re-renders when the session's state changes.
 */
export const SessionStatusIndicator = memo<{ sessionId: string; messageCount?: number; runningInRollup?: boolean }>(({ sessionId, messageCount, runningInRollup }) => {
  // Use aggregated atom that checks this session AND any children (for workstreams)
  const hasPendingInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(sessionId));
  const isProcessing = useAtomValue(sessionOrChildProcessingAtom(sessionId));
  const hasPendingPrompt = useAtomValue(sessionPendingPromptAtom(sessionId));
  const hasAgentWakePending = useAtomValue(sessionAgentWakePendingAtom(sessionId));
  const hasUnread = useAtomValue(sessionUnreadAtom(sessionId));
  const wakeup = useAtomValue(sessionWakeupAtom(sessionId));
  // Lead turn is over; the session is only draining background shells/sub-agents.
  const backgroundTasks = useAtomValue(sessionBackgroundTasksAtom(sessionId));

  // Priority: waiting for input > processing > pending prompt > scheduled wakeup > unread > message count
  // All interactive prompts (AskUserQuestion, ExitPlanMode, ToolPermission, etc.) show same indicator
  if (hasPendingInteractivePrompt) {
    return (
      <div className="session-list-item-status waiting-for-input flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="contact_support" size={14} />
      </div>
    );
  }

  if (isProcessing && backgroundTasks?.length) {
    return (
      <div className="session-list-item-status background-wait flex items-center justify-center w-5 h-5 text-[var(--nim-text-muted)] animate-pulse" title={describeBackgroundWait(backgroundTasks, Date.now())}>
        <MaterialSymbol icon="timelapse" size={14} />
      </div>
    );
  }

  if (isProcessing) {
    if (runningInRollup) return null;
    return (
      <div className="session-list-item-status processing flex items-center justify-center w-5 h-5 text-[var(--nim-primary)] opacity-80" title="Processing...">
        <MaterialSymbol icon="progress_activity" size={14} className="animate-spin" />
      </div>
    );
  }

  if (hasAgentWakePending) {
    return (
      <div className="session-list-item-status agent-wake-pending flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Room message pending agent dispatch">
        <MaterialSymbol icon="hourglass_top" size={14} />
      </div>
    );
  }

  if (hasPendingPrompt) {
    return (
      <div className="session-list-item-status pending-prompt flex items-center justify-center w-5 h-5 text-[var(--nim-warning)] animate-pulse" title="Waiting for your response">
        <MaterialSymbol icon="help" size={14} />
      </div>
    );
  }

  if (wakeup) {
    const isOverdue = wakeup.status === 'overdue';
    const colorClass = isOverdue ? 'text-[var(--nim-warning)]' : 'text-[var(--nim-primary)]';
    const tooltip = isOverdue
      ? `Overdue wakeup${wakeup.reason ? ` — ${wakeup.reason}` : ''}`
      : `Scheduled wakeup at ${new Date(wakeup.fireAt).toLocaleString()}${wakeup.reason ? ` — ${wakeup.reason}` : ''}`;
    return (
      <div className={`session-list-item-status wakeup flex items-center justify-center w-5 h-5 ${colorClass} opacity-80`} title={tooltip}>
        <MaterialSymbol icon="schedule" size={14} />
      </div>
    );
  }

  if (hasUnread) {
    return (
      <div className="session-list-item-status unread flex items-center justify-center w-5 h-5 text-[var(--nim-primary)]" title="Unread response">
        <MaterialSymbol icon="circle" size={8} fill />
      </div>
    );
  }

  // if (messageCount !== undefined) {
  //   return <span className="session-list-item-message-count">{messageCount}</span>;
  // }

  return null;
});

// This leaf owns its expiry timer: following never ticks the parent or sibling rows.
const EXTERNAL_ACTIVITY_RECENT_MS = 30_000;
const SessionExternalMarker = memo(function SessionExternalMarker({ sessionId }: { sessionId: string }) {
  const source = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.externalSource), [sessionId]));
  const lastActivity = useAtomValue(useMemo(() => atom(get => get(sessionRegistryAtom).get(sessionId)?.externalLastActivityAt), [sessionId]));
  const enabled = useAtomValue(settingAtom('app.externalSessionFollowEnabled')) === true;
  const [, expire] = useState(0);
  const age = Date.now() - (lastActivity ?? 0);
  const following = !!source && enabled && lastActivity !== undefined && age >= 0 && age < EXTERNAL_ACTIVITY_RECENT_MS;

  useEffect(() => {
    if (!following || lastActivity === undefined) return;
    const timer = setTimeout(() => expire(value => value + 1), Math.max(0, lastActivity + EXTERNAL_ACTIVITY_RECENT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [source, enabled, lastActivity, following]);

  if (!source) return null;
  return (
    <span className="session-list-item-external inline-flex gap-1 whitespace-nowrap text-[var(--nim-text-muted)]" title={`Imported from ${source === 'claude-code' ? 'Claude Code' : 'Codex'}`}>
      <span>External</span>
      {following && <span className="session-list-item-following text-[var(--nim-primary)]" title="Recent external session activity">Following</span>}
    </span>
  );
});

interface SessionListItemProps {
  id: string;
  treeContext?: boolean;
  isChild?: boolean;
  worktreeLabel?: string;
  onWorktreeMenu?: (event: React.MouseEvent) => void;
  treeLeading?: React.ReactNode;
  /** Compact child count and activity summary beside the title. */
  treeDetails?: React.ReactNode;
  /** Single-line row: title, inline summary and time. */
  compact?: boolean;
  title: string;
  createdAt: number;
  updatedAt?: number;
  isActive: boolean;
  isLoaded?: boolean; // Whether session is loaded in a tab
  /** @deprecated Uses Jotai atom subscription - do not pass */
  isProcessing?: boolean;
  /** @deprecated Uses Jotai atom subscription - do not pass */
  hasUnread?: boolean;
  /** @deprecated Uses Jotai atom subscription - do not pass */
  hasPendingPrompt?: boolean;
  isArchived?: boolean; // Whether session is archived
  isPinned?: boolean; // Whether session is pinned to the top
  isSelected?: boolean; // Whether session is selected for bulk actions
  selectedCount?: number; // Number of sessions currently selected (for context menu labels)
  sortBy?: 'updated' | 'created'; // Which timestamp to display based on sort order
  onClick: (e: React.MouseEvent) => void;
  onDelete?: () => void;
  onArchive?: () => void;
  onUnarchive?: () => void;
  onRename?: (newName: string) => void; // Callback when session is renamed
  onPinToggle?: (isPinned: boolean) => void; // Callback when pin status changes
  onBranch?: () => void; // Callback when user wants to branch this session
  provider?: string;
  model?: string;
  messageCount?: number;
  sessionType?: 'session' | 'workstream' | 'blitz' | 'voice'; // Structural type of session
  isWorkstream?: boolean; // Explicit workstream container or session with children
  isExpanded?: boolean; // Tree rows: whether the row's children are showing (folder_open icon)
  /** Every selected session when this row is part of a multi-selection; move actions apply to all. */
  selectedSessionIds?: readonly string[];
  isWorktreeSession?: boolean; // Whether this session belongs to a worktree (shows worktree icon)
  parentSessionId?: string | null; // Parent session ID for hierarchical workstreams
  projectPath?: string; // Workspace path for drag-drop validation
  uncommittedCount?: number; // Number of uncommitted files in this session
  branchedAt?: number; // Timestamp when this session was branched (branch tracking)
  phase?: string; // Kanban board phase (backlog, planning, implementing, validating, complete)
}

// Named rather than an inline arrow so the render profiler can report it by
// name instead of "Memo <- SessionHistory". See docs/RENDER_PERFORMANCE.md.
export const SessionListItem = memo<SessionListItemProps>(function SessionListItem({
  id,
  treeContext,
  isChild = false,
  worktreeLabel,
  onWorktreeMenu,
  treeLeading,
  treeDetails,
  compact,
  title,
  createdAt,
  updatedAt,
  isActive,
  isLoaded = false,
  isProcessing = false,
  hasUnread = false,
  hasPendingPrompt = false,
  isArchived = false,
  isPinned = false,
  isSelected = false,
  selectedCount = 1,
  sortBy = 'updated',
  onClick,
  onDelete,
  onArchive,
  onUnarchive,
  onRename,
  onPinToggle,
  onBranch,
  provider,
  model,
  messageCount,
  sessionType,
  isWorkstream = false,
  isExpanded = false,
  selectedSessionIds,
  isWorktreeSession = false,
  parentSessionId = null,
  projectPath,
  uncommittedCount,
  branchedAt,
  phase,
}) {
  const appearance = useAtomValue(settingAtom('ui.sessionListAppearance'));
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const [movePicker, setMovePicker] = useState<null | 'parent' | 'workstreams'>(null);
  const detailsAllowed = !isRenaming && !showContextMenu && !movePicker;
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { refs, floatingStyles, context } = useFloating({
    open: detailsOpen && detailsAllowed,
    onOpenChange: setDetailsOpen,
    placement: 'right-start',
    middleware: [offset(10), flip(), shift({ padding: 12 })],
    whileElementsMounted: autoUpdate,
  });
  const { getReferenceProps, getFloatingProps } = useInteractions([
    useHover(context, { enabled: detailsAllowed, delay: { open: 550, close: 120 }, handleClose: safePolygon() }),
    useFocus(context, { enabled: detailsAllowed }),
    useDismiss(context),
    useRole(context, { role: 'dialog' }),
  ]);
  const { move, moveMany, canJoinWorkstream, isDragging, isDraggable, hint, onDragStart: handleDragStart, onDragEnd: handleDragEnd, onDragOver: handleDragOver, onDragLeave: handleDragLeave, onDrop: handleDrop } = useSessionTreeMove(id, projectPath);

  // Share state (for the share icon indicator in the list item)
  const shareInfo = useAtomValue(sessionShareAtom(id));

  // Awaiting input state (interactive prompt or pending prompt)
  const hasInteractivePrompt = useAtomValue(sessionHasPendingInteractivePromptAtom(id));
  const hasPendingPromptAtom = useAtomValue(sessionPendingPromptAtom(id));
  const isAwaitingInput = hasInteractivePrompt || hasPendingPromptAtom;

  const handleRemoveFromWorkstream = useCallback(() => { void move(id, null); }, [move, id]);
  const moveIds = isSelected && selectedSessionIds && selectedSessionIds.length > 1 ? selectedSessionIds : [id];
  const createWorkstream = useSetAtom(createWorkstreamAtom);
  const handleCreateWorkstream = useCallback(async (name: string) => {
    if (!projectPath) return false;
    invalidateSessionMoveUndo();
    const created = await createWorkstream({ workspacePath: projectPath, title: name || undefined, sessionIds: moveIds, rename: !name });
    if (!created) {
      errorNotificationService.showError('Cannot create workstream', 'The workstream could not be created. Try again.');
      return false;
    }
    // The workstream stays even if moves fail, so the user can drag sessions into it.
    const total = moveIds.length;
    const label = name || 'New Workstream';
    if (created.failed === total)
      errorNotificationService.showError('Sessions not moved', `Created "${label}", but none of the ${total === 1 ? 'session' : `${total} sessions`} could move into it, so it is empty.`);
    else if (created.failed > 0)
      errorNotificationService.showError('Some sessions were not moved', `Moved ${total - created.failed} of ${total} sessions into "${label}"; ${created.failed} could not move.`);
    else errorNotificationService.showInfo('Sessions moved', `Moved ${total === 1 ? 'the session' : `${total} sessions`} into "${label}"`, { duration: 5000 });
    return true;
  }, [createWorkstream, projectPath, moveIds]);

  // A row created by "New Workstream" opens its title editor as soon as it renders.
  const renameRequested = useAtomValue(useMemo(() => atom((get) => get(pendingSessionRenameAtom) === id), [id]));
  const clearRenameRequest = useSetAtom(pendingSessionRenameAtom);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenuPosition({ x: e.clientX, y: e.clientY });
    setShowContextMenu(true);
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setShowContextMenu(false);
  }, []);

  const handleRenameSubmit = () => {
    const trimmedValue = renameValue.trim();
    if (trimmedValue && trimmedValue !== title && onRename) {
      onRename(trimmedValue);
    }
    setIsRenaming(false);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setIsRenaming(false);
    }
  };

  useEffect(() => {
    if (!renameRequested) return;
    clearRenameRequest(null);
    if (!onRename) return;
    setRenameValue(title);
    setIsRenaming(true);
  }, [renameRequested, clearRenameRequest, onRename, title]);

  // Auto-focus and select text when rename input appears
  useEffect(() => {
    if (isRenaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [isRenaming]);

  const displayTitle = title || 'Untitled Session';

  // Per-session live activity. Bumped on every `ai:message-logged`; only
  // this list item re-renders when its own activity ticks, instead of the
  // whole SessionHistory + 705 siblings. Fall back to the registry's
  // `updatedAt` (set at DB refresh / on terminal session events) when no
  // activity has been recorded since mount.
  const liveActivity = useAtomValue(sessionLastActivityAtom(id));
  const effectiveUpdatedAt = liveActivity > 0 ? liveActivity : updatedAt;

  // Show timestamp based on current sort order
  const timestamp = sortBy === 'updated' ? (effectiveUpdatedAt || createdAt) : createdAt;
  const timestampLabel = sortBy === 'updated' ? 'updated' : 'created';

  // A quiet session still ages: relativeTime is derived from a fixed timestamp,
  // so without a periodic re-render the "X ago" label sits frozen until the
  // session next has activity (#1200). One coarse tick a minute matches the
  // finest granularity getRelativeTimeString renders — same approach as the
  // Inbox section's relative labels.
  const [relativeTimeTick, setRelativeTimeTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setRelativeTimeTick((t) => t + 1), 60_000);
    return () => clearInterval(timer);
  }, []);

  const { relativeTime, fullDateTime } = useMemo(() => ({
    relativeTime: getRelativeTimeString(timestamp),
    fullDateTime: new Date(timestamp).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZoneName: 'short'
    }),
  }), [timestamp, relativeTimeTick]);

  // Extract model ID from provider:model format
  const displayModel = model?.includes(':') ? model.split(':')[1] : model;

  return (
    <>
    <div
      ref={refs.setReference}
      {...getReferenceProps({
        onKeyDown: (e: React.KeyboardEvent<HTMLDivElement>) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick(e as unknown as React.MouseEvent);
          }
        },
      })}
        id={"session-list-item-" + id}
      data-testid={isWorktreeSession ? 'worktree-session-item' : isWorkstream ? 'workstream-session-item' : 'session-list-item'}
      data-session-type={isWorktreeSession ? 'worktree' : isWorkstream ? 'workstream' : 'session'}
      className={`session-list-item ${isChild ? 'is-child' : ''} context-${appearance.childContext} relative flex ${compact ? 'compact items-center py-0.5' : 'items-start py-1'} gap-2.5 pr-3 pl-7 cursor-pointer rounded mr-2 transition-[background-color,opacity] duration-150 select-none
        focus:outline-2 focus:outline-[var(--nim-border-focus)] focus:-outline-offset-2
        ${isActive ? 'active' : ''}
        ${isLoaded ? 'loaded' : ''}
        ${isArchived ? 'archived opacity-60 hover:opacity-80' : ''}
        ${isSelected ? 'selected' : ''}
        ${isPinned ? 'pinned' : ''}
        ${isDragging ? 'dragging opacity-50 cursor-grabbing' : ''}
        ${hint?.valid ? 'drop-target-valid bg-[rgba(83,89,93,0.4)] border-2 border-dashed border-[var(--nim-primary)]' : ''}
        ${hint?.between && hint.valid ? 'border-t-2 border-[var(--nim-primary)]' : ''}
        ${isDraggable ? 'cursor-grab' : ''}
      `}
      style={{ ...sessionAppearanceVariables(appearance), ...(isAwaitingInput ? { borderLeft: '2px solid var(--nim-warning)' } : {}), ...(treeContext ? { marginLeft: 0 } : {}), ...(hint && !hint.valid ? { cursor: 'not-allowed' } : {}) } as React.CSSProperties}
      onClick={onClick}
      onContextMenu={handleContextMenu}
      draggable={isDraggable}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      role="button"
      tabIndex={0}
      aria-label={`Session: ${displayTitle}, ${timestampLabel} ${relativeTime}${isLoaded ? ' (loaded in tab)' : ''}${isArchived ? ' (archived)' : ''}`}
      aria-current={isActive ? 'page' : undefined}
    >
      {treeLeading}
      {(isChild ? appearance.showChildIcon : appearance.showParentIcon) && <div className={`session-list-item-icon shrink-0 ${compact ? "" : "mt-0.5"} text-[var(--nim-text-muted)] flex items-center relative ${isActive ? '[&]:text-[var(--nim-primary)] [&_svg]:text-[var(--nim-primary)]' : '[&_svg]:text-[var(--nim-text-muted)]'} ${isWorkstream ? 'workstream-icon' : ''} ${isWorktreeSession ? 'worktree-icon' : ''}`}>
        {sessionType === 'voice' ? (
          // Voice session: OpenAI icon with mic badge
          <div className="relative">
            <ProviderIcon provider="openai" size={14} />
            <MaterialSymbol
              icon="mic"
              size={12}
              className="absolute -bottom-1 -right-1.5 text-[var(--nim-text-muted)]"
              fill
            />
          </div>
        ) : isWorktreeSession && !treeContext ? (
          <WorktreeIcon size={14} />
        ) : sessionType === 'workstream' ? (
          // The container gets a folder; a session with children keeps its provider icon.
          <MaterialSymbol icon={isExpanded ? 'folder_open' : 'folder'} size={14} />
        ) : (
          <SessionProviderIcon sessionId={id} provider={provider} size={14} isActive={isActive} hideLaunchCount={treeContext} />
        )}
      </div>}
      <div className="session-list-item-content flex-1 min-w-0 overflow-hidden">
        {isRenaming ? (
          <input
            ref={renameInputRef}
            type="text"
            className="session-list-item-rename-input w-full px-2 py-1 text-[0.8125rem] font-medium border border-[var(--nim-primary)] rounded bg-[var(--nim-bg)] text-[var(--nim-text)] outline-none box-border"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={handleRenameKeyDown}
            onBlur={handleRenameSubmit}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
            <div className="session-list-item-headline flex items-center gap-1.5 min-w-0">
              <FullTitleTooltip label={displayTitle} disabled={detailsOpen && !!detailsAllowed} className={`session-list-item-title block flex-1 min-w-0 text-[0.8125rem] text-[var(--nim-text)] overflow-hidden text-ellipsis whitespace-nowrap ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {displayTitle}
              </FullTitleTooltip>
              {(isPinned || branchedAt || shareInfo) && <div className="session-list-item-source-markers">
                {isPinned && <MaterialSymbol icon="push_pin" size={10} title="Pinned" />}
                {branchedAt && <MaterialSymbol icon="fork_right" size={10} title="Branched conversation" />}
                {shareInfo && <MaterialSymbol icon="link" size={10} title="Shared" />}
              </div>}
              {isChild && <span className="session-list-item-child-status">
                {treeDetails}
                <SessionWorkAttentionIndicator sessionIds={[id]} descendantsOnly />
                <SessionStatusIndicator sessionId={id} messageCount={messageCount} runningInRollup={!!treeDetails} />
              </span>}
              {appearance.showTimestamps && <span className="session-list-item-datetime" title={fullDateTime}>{relativeTime}</span>}
            </div>
            <SessionWorkCaption sessionId={id} />
            {!isChild && <div className="session-list-item-eyebrow">
              {treeDetails}
              <SessionWorkAttentionIndicator sessionIds={[id]} descendantsOnly />
              <SessionStatusIndicator sessionId={id} messageCount={messageCount} runningInRollup={!!treeDetails} />
            </div>}
            <div className="session-list-item-secondary" style={{ display: appearance.showModel ? undefined : 'none' }}>
              <span className="session-list-item-model" title={displayModel ? `Model: ${displayModel}` : 'Model not recorded'}>{displayModel || 'Model —'}</span>
            </div>
            <SessionContextUsageBar sessionId={id} />
            {hint && <div className="session-tree-drop-hint text-xs text-[var(--nim-primary)]" role="status">{hint.label}</div>}
          </>
        )}
      </div>
      <div className="session-list-item-right shrink-0 flex items-center gap-1.5 ml-auto">
        {uncommittedCount !== undefined && uncommittedCount > 0 && (
          <span className="session-list-item-badge uncommitted text-[0.6875rem] px-1.5 py-0.5 rounded-xl font-semibold whitespace-nowrap bg-[rgba(245,158,11,0.15)] text-[var(--nim-warning)]" title={`${uncommittedCount} uncommitted file${uncommittedCount !== 1 ? 's' : ''}`} aria-label={`${uncommittedCount} uncommitted files`}>
            <MaterialSymbol icon="draft" size={10} />{uncommittedCount}
          </span>
        )}

      </div>

      {movePicker && (
        <SessionMovePicker
          sessionId={id}
          mode={movePicker}
          onMove={(parentId) => (movePicker === 'workstreams' ? moveMany(moveIds, parentId) : move(id, parentId))}
          onCreateWorkstream={movePicker === 'workstreams' ? handleCreateWorkstream : undefined}
          onClose={() => setMovePicker(null)}
        />
      )}

      {/* Context Menu */}
      {showContextMenu && (
        <SessionContextMenu
          sessionId={id}
          title={title}
          position={contextMenuPosition}
          onClose={handleCloseContextMenu}
          isArchived={isArchived}
          isPinned={isPinned}
          isWorkstream={isWorkstream}
          isWorktreeSession={isWorktreeSession}
          parentSessionId={parentSessionId}
          phase={phase}
          onRename={onRename ? () => { setRenameValue(title); setIsRenaming(true); } : undefined}
          onPinToggle={onPinToggle}
          onBranch={onBranch}
          onRemoveFromWorkstream={parentSessionId ? handleRemoveFromWorkstream : undefined}
          onMoveUnder={isDraggable ? () => setMovePicker('parent') : undefined}
          onMoveToWorkstream={canJoinWorkstream && projectPath ? () => setMovePicker('workstreams') : undefined}
          onArchive={onArchive}
          onUnarchive={onUnarchive}
          onDelete={onDelete}
          selectedCount={selectedCount}
          moveCount={moveIds.length}
        />
      )}
    </div>
    {detailsOpen && detailsAllowed && (
      <FloatingPortal>
        <FloatingFocusManager context={context} modal={false} initialFocus={-1} returnFocus={false}>
          <div ref={refs.setFloating} style={floatingStyles} {...getFloatingProps()}
            aria-label={`Details for ${displayTitle}`} className="session-row-details-popover select-text">
            <div className="session-row-details-title">{displayTitle}</div>
            <div className="session-row-details-metadata">
              <SessionWorkSummaryDetails sessionId={id} workspacePath={projectPath ?? ''} />
              {displayModel && <div>Model: {displayModel}</div>}
              {worktreeLabel && <div>Worktree: {worktreeLabel}</div>}
              {onWorktreeMenu && <button type="button" className="session-work-refresh" onClick={onWorktreeMenu}>Worktree actions…</button>}
              <SessionContextUsageBar sessionId={id} variant="details" />
              {phase && <div>Phase: {phase}</div>}
              <div>{timestampLabel}: {fullDateTime}</div>
              <SessionExternalMarker sessionId={id} />
              <SessionSpawnerLink sessionId={id} />
            </div>
          </div>
        </FloatingFocusManager>
      </FloatingPortal>
    )}
    </>
  );
}, (prev, next) => {
  return (
    prev.treeContext === next.treeContext &&
    prev.isChild === next.isChild &&
    prev.worktreeLabel === next.worktreeLabel &&
    prev.onWorktreeMenu === next.onWorktreeMenu &&
    prev.treeLeading === next.treeLeading &&
    prev.treeDetails === next.treeDetails &&
    prev.compact === next.compact &&
    prev.id === next.id &&
    prev.title === next.title &&
    prev.createdAt === next.createdAt &&
    prev.updatedAt === next.updatedAt &&
    prev.isActive === next.isActive &&
    prev.isLoaded === next.isLoaded &&
    prev.isArchived === next.isArchived &&
    prev.isPinned === next.isPinned &&
    prev.isSelected === next.isSelected &&
    prev.selectedCount === next.selectedCount &&
    prev.sortBy === next.sortBy &&
    prev.provider === next.provider &&
    prev.model === next.model &&
    prev.messageCount === next.messageCount &&
    prev.sessionType === next.sessionType &&
    prev.isWorkstream === next.isWorkstream &&
    prev.isExpanded === next.isExpanded &&
    prev.selectedSessionIds === next.selectedSessionIds &&
    prev.isWorktreeSession === next.isWorktreeSession &&
    prev.parentSessionId === next.parentSessionId &&
    prev.projectPath === next.projectPath &&
    prev.uncommittedCount === next.uncommittedCount &&
    prev.branchedAt === next.branchedAt &&
    prev.phase === next.phase
  );
});
