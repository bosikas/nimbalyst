import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useAtomValue, useSetAtom } from 'jotai';
import { FloatingPortal, flip, offset, shift, useClick, useDismiss, useFloating, useInteractions, useRole } from '@floating-ui/react';
import { MaterialSymbol, ProviderIcon } from '@nimbalyst/runtime';
import { windowControlsClearance } from '@nimbalyst/runtime/ui/floating/windowControlsClearance';
import { agentFilePlacementAtom } from '../../store/atoms/agentFilePlacement';
import { sessionKanbanTagsAtom, setSessionTagsAtom } from '../../store/atoms/sessionKanban';
import {
  publishSessionPinnedUpdateAtom,
  sessionRegistryAtom,
  sessionStoreAtom,
  updateSessionStoreAtom,
  workstreamProcessingAtom,
  workstreamSessionsAtom,
  workstreamTagsAtom,
  workstreamTitleAtom,
} from '../../store/atoms/sessions';
import { setWorkstreamLayoutModeAtom, workstreamHasOpenResourcesAtom, workstreamLayoutModeAtom, type WorkstreamLayoutMode } from '../../store/atoms/workstreamState';
import { patchWorktreeRecordAtom, worktreeRecordAtom } from '../../store/atoms/worktrees';
import { getWorktreeNameFromPath } from '../../utils/pathUtils';
import { saveSessionArchived } from '../../utils/saveSessionArchived';
import { CoordinatedSessionsLinks, CoordinatorLink } from '../AgenticCoding/SessionCoordination';
import { ActiveSessionMcpStatusChip } from '../AgenticCoding/McpSessionStatusChip';
import { WorktreeIcon } from '../common/WorktreeIcon';
import { ChatAppearanceControl } from '../UnifiedAI/ChatAppearanceControl';
import { LayoutControls } from '../UnifiedAI/LayoutControls';
import { toggleWorkstreamHeaderPin } from './workstreamHeaderPin';

/**
 * Tag pill row that fits as many tags as the container allows on a single line.
 * Overflowing tags collapse into a "+N" pill that opens a floating dropdown.
 *
 * Measurement runs in a hidden layer that mirrors the real pill widths, so the
 * visible row never has to render-then-clip the overflowing pills.
 */
const TAG_PILL_CLASS = "group flex items-center gap-0.5 text-[10px] font-medium leading-none pl-1.5 pr-1 py-0.5 rounded-full whitespace-nowrap cursor-default text-nim-faint bg-[color-mix(in_srgb,var(--nim-text)_8%,transparent)]";
const TAG_OVERFLOW_PILL_CLASS = "flex items-center gap-0.5 text-[10px] font-medium leading-none px-1.5 py-0.5 rounded-full whitespace-nowrap cursor-pointer text-nim-faint bg-[color-mix(in_srgb,var(--nim-text)_8%,transparent)] hover:bg-[color-mix(in_srgb,var(--nim-text)_14%,transparent)] border-none";

const WorkstreamHeaderTagsRow: React.FC<{ workstreamId: string }> = ({ workstreamId }) => {
  const tags = useAtomValue(workstreamTagsAtom(workstreamId));
  const allTags = useAtomValue(sessionKanbanTagsAtom);
  const registry = useAtomValue(sessionRegistryAtom);
  const setSessionTags = useSetAtom(setSessionTagsAtom);

  const rootTags = registry.get(workstreamId)?.tags ?? [];

  const [isEditingTags, setIsEditingTags] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const tagInputRef = useRef<HTMLInputElement>(null);
  const tagDropdownRef = useRef<HTMLDivElement>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(tags.length);

  const [overflowOpen, setOverflowOpen] = useState(false);
  const { refs: overflowRefs, floatingStyles: overflowFloatingStyles, context: overflowContext } = useFloating({
    open: overflowOpen,
    onOpenChange: setOverflowOpen,
    placement: 'bottom-end',
    middleware: [offset(6), flip({ padding: 8 }), shift({ padding: 8 }), windowControlsClearance()],
  });
  const overflowClick = useClick(overflowContext);
  const overflowDismiss = useDismiss(overflowContext);
  const overflowRole = useRole(overflowContext, { role: 'menu' });
  const { getReferenceProps: getOverflowReferenceProps, getFloatingProps: getOverflowFloatingProps } = useInteractions([overflowClick, overflowDismiss, overflowRole]);

  // Close the suggestions dropdown when clicking outside the input.
  useEffect(() => {
    if (!isEditingTags) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (
        tagDropdownRef.current && !tagDropdownRef.current.contains(e.target as Node) &&
        tagInputRef.current && !tagInputRef.current.contains(e.target as Node)
      ) {
        setIsEditingTags(false);
        setTagInput('');
      }
    };
    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsEditingTags(false);
        setTagInput('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isEditingTags]);

  useEffect(() => {
    if (isEditingTags && tagInputRef.current) {
      tagInputRef.current.focus();
    }
  }, [isEditingTags]);

  const handleAddTag = useCallback((tag: string) => {
    const trimmed = tag.trim().toLowerCase();
    if (!trimmed || rootTags.includes(trimmed)) return;
    setSessionTags({ sessionId: workstreamId, tags: [...rootTags, trimmed] });
    setTagInput('');
  }, [workstreamId, rootTags, setSessionTags]);

  const handleRemoveTag = useCallback((tag: string) => {
    setSessionTags({ sessionId: workstreamId, tags: rootTags.filter(t => t !== tag) });
  }, [workstreamId, rootTags, setSessionTags]);

  const handleTagInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && tagInput.trim()) {
      e.preventDefault();
      handleAddTag(tagInput);
    } else if (e.key === 'Backspace' && !tagInput && rootTags.length > 0) {
      handleRemoveTag(rootTags[rootTags.length - 1]);
    } else if (e.key === 'Escape') {
      setIsEditingTags(false);
      setTagInput('');
    }
  }, [tagInput, rootTags, handleAddTag, handleRemoveTag]);

  const filteredSuggestions = React.useMemo(() => {
    if (!tagInput.trim()) return [];
    const q = tagInput.trim().toLowerCase();
    return allTags
      .filter(t => t.name.toLowerCase().includes(q) && !tags.includes(t.name))
      .slice(0, 5);
  }, [tagInput, allTags, tags]);

  // Content key so the layout effect only re-runs when tag contents change.
  const tagsKey = tags.join('\u0000');

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure) return;

    const compute = () => {
      const containerWidth = container.clientWidth;
      if (containerWidth <= 0) return;

      const tagEls = Array.from(measure.querySelectorAll<HTMLElement>('[data-measure-tag]'));
      const overflowEl = measure.querySelector<HTMLElement>('[data-measure-overflow]');
      const trailingEl = measure.querySelector<HTMLElement>('[data-measure-trailing]');

      const GAP = 4; // matches gap-1
      const trailingWidth = trailingEl ? trailingEl.offsetWidth + GAP : 0;
      const overflowWidth = overflowEl ? overflowEl.offsetWidth + GAP : 0;

      let used = 0;
      let count = 0;
      for (let i = 0; i < tagEls.length; i++) {
        const w = tagEls[i].offsetWidth;
        const gap = count > 0 ? GAP : 0;
        const remaining = tagEls.length - i - 1;
        const overflowReserve = remaining > 0 ? overflowWidth : 0;
        if (used + gap + w + overflowReserve + trailingWidth > containerWidth) break;
        used += gap + w;
        count++;
      }

      setVisibleCount(count);
    };

    const ro = new ResizeObserver(compute);
    ro.observe(container);
    compute();
    return () => ro.disconnect();
  }, [tagsKey, isEditingTags]);

  const visibleTags = tags.slice(0, visibleCount);
  const hiddenTags = tags.slice(visibleCount);
  const hasOverflow = hiddenTags.length > 0;

  const renderTrailing = () => (
    isEditingTags ? (
      <div className="relative">
        <input
          ref={tagInputRef}
          type="text"
          className="text-[10px] leading-none py-0.5 px-1.5 rounded-full border border-[var(--nim-border)] bg-[var(--nim-bg-secondary)] text-[var(--nim-text)] outline-none w-[80px]"
          placeholder="add tag..."
          value={tagInput}
          onChange={(e) => setTagInput(e.target.value)}
          onKeyDown={handleTagInputKeyDown}
          onBlur={() => {
            setTimeout(() => {
              setIsEditingTags(false);
              setTagInput('');
            }, 150);
          }}
        />
        {filteredSuggestions.length > 0 && (
          <div
            ref={tagDropdownRef}
            className="absolute top-full left-0 mt-1 min-w-[120px] rounded-md z-[10000] py-0.5 text-[11px] bg-nim border border-nim shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
          >
            {filteredSuggestions.map(s => (
              <div
                key={s.name}
                className="px-2 py-1 cursor-pointer text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                onMouseDown={(e) => { e.preventDefault(); handleAddTag(s.name); }}
              >
                {s.name} <span className="text-[var(--nim-text-faint)]">({s.count})</span>
              </div>
            ))}
          </div>
        )}
      </div>
    ) : (
      <button
        className="flex items-center justify-center w-4 h-4 rounded-full border border-dashed border-[var(--nim-border)] bg-transparent cursor-pointer text-[var(--nim-text-faint)] hover:border-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)] transition-colors duration-100"
        onClick={() => setIsEditingTags(true)}
        title="Add tag"
      >
        <MaterialSymbol icon="add" size={10} />
      </button>
    )
  );

  return (
    <div
      ref={containerRef}
      className="workstream-header-tags flex-1 self-stretch flex items-center gap-1 flex-nowrap overflow-hidden min-w-0 relative"
    >
      {/* Hidden measurement layer. Mirrors visible-pill sizes without taking layout space. */}
      <div
        ref={measureRef}
        aria-hidden
        className="flex items-center gap-1 absolute left-0 top-0 pointer-events-none invisible"
      >
        {tags.map(tag => (
          <span key={tag} data-measure-tag className={TAG_PILL_CLASS}>
            {tag}
            <span className="flex items-center justify-center w-3 h-3 rounded-full">
              <MaterialSymbol icon="close" size={10} />
            </span>
          </span>
        ))}
        {tags.length > 0 && (
          <span data-measure-overflow className={TAG_OVERFLOW_PILL_CLASS}>
            +{tags.length}
          </span>
        )}
        <div data-measure-trailing>
          {isEditingTags ? (
            <span className="inline-block w-[80px] h-[18px] rounded-full border border-[var(--nim-border)]" />
          ) : (
            <span className="flex items-center justify-center w-4 h-4 rounded-full border border-dashed border-[var(--nim-border)]">
              <MaterialSymbol icon="add" size={10} />
            </span>
          )}
        </div>
      </div>

      {visibleTags.map(tag => (
        <span key={tag} className={TAG_PILL_CLASS}>
          {tag}
          <button
            className="opacity-0 group-hover:opacity-100 flex items-center justify-center w-3 h-3 rounded-full border-none bg-transparent cursor-pointer text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] transition-opacity duration-100"
            onClick={() => handleRemoveTag(tag)}
            title={`Remove tag "${tag}"`}
          >
            <MaterialSymbol icon="close" size={10} />
          </button>
        </span>
      ))}

      {hasOverflow && (
        <>
          <button
            ref={overflowRefs.setReference}
            {...getOverflowReferenceProps()}
            className={TAG_OVERFLOW_PILL_CLASS}
            title={`Show ${hiddenTags.length} more tag${hiddenTags.length === 1 ? '' : 's'}`}
          >
            +{hiddenTags.length}
          </button>
          {overflowOpen && (
            <FloatingPortal>
              <div
                ref={overflowRefs.setFloating}
                style={overflowFloatingStyles}
                {...getOverflowFloatingProps()}
                className="z-[10000] min-w-[140px] max-h-[300px] overflow-y-auto rounded-md py-1 bg-nim border border-nim shadow-[0_4px_12px_rgba(0,0,0,0.3)]"
              >
                {hiddenTags.map(tag => (
                  <div
                    key={tag}
                    className="group flex items-center justify-between gap-2 px-2 py-1 text-[11px] text-[var(--nim-text-muted)] hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text)]"
                  >
                    <span className="truncate">{tag}</span>
                    <button
                      className="flex items-center justify-center w-4 h-4 rounded-full opacity-0 group-hover:opacity-100 text-[var(--nim-text-faint)] hover:text-[var(--nim-text)] bg-transparent border-none cursor-pointer"
                      onClick={() => handleRemoveTag(tag)}
                      title={`Remove tag "${tag}"`}
                    >
                      <MaterialSymbol icon="close" size={10} />
                    </button>
                  </div>
                ))}
              </div>
            </FloatingPortal>
          )}
        </>
      )}

      {renderTrailing()}
    </div>
  );
};

/**
 * atomFamily key used when the workstream is not a worktree. The family needs a
 * string, and this never resolves to a record.
 */
export const NO_WORKTREE_KEY = '__no_worktree__';

/**
 * Header showing workstream title, provider icon, processing state, and layout controls.
 * Subscribes to atoms directly for isolated re-renders.
 */
export const WorkstreamHeader: React.FC<{
  workstreamId: string;
  /**
   * The session currently in view — the workstream's active child, or the
   * workstream itself when it is a solo session. Per-session chrome (today:
   * the MCP status chip) keys off this rather than workstreamId, since a
   * workstream's tabs can be on different providers.
   */
  activeSessionId?: string | null;
  worktreeId?: string | null;
  worktreePath?: string | null;
  onArchiveStatusChange?: () => void;
  onOpenTerminal?: () => void;
  onCreateNewTerminal?: () => void;
  onShowArchiveDialog?: () => void;
  archiveDisabled?: boolean;
  onOpenSession?: (sessionId: string) => void;
}> = React.memo(({ workstreamId, activeSessionId, worktreeId, worktreePath, onArchiveStatusChange, onOpenTerminal, onCreateNewTerminal, onShowArchiveDialog, archiveDisabled, onOpenSession }) => {
  const title = useAtomValue(workstreamTitleAtom(workstreamId));
  const isProcessing = useAtomValue(workstreamProcessingAtom(workstreamId));
  const sessionData = useAtomValue(sessionStoreAtom(workstreamId));
  const sessionMeta = useAtomValue(sessionRegistryAtom).get(workstreamId);
  const layoutMode = useAtomValue(workstreamLayoutModeAtom(workstreamId));
  const filePlacement = useAtomValue(agentFilePlacementAtom);
  const hasTabs = useAtomValue(workstreamHasOpenResourcesAtom(workstreamId));
  const sessions = useAtomValue(workstreamSessionsAtom(workstreamId));
  const isArchived = sessionData?.isArchived ?? sessionMeta?.isArchived ?? false;
  const worktreeRecord = useAtomValue(worktreeRecordAtom(worktreeId ?? NO_WORKTREE_KEY));
  const setLayoutMode = useSetAtom(setWorkstreamLayoutModeAtom);
  const updateSessionStore = useSetAtom(updateSessionStoreAtom);
  const patchWorktreeRecord = useSetAtom(patchWorktreeRecordAtom);
  const publishSessionPinnedUpdate = useSetAtom(publishSessionPinnedUpdateAtom);

  // Inline editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(title ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Terminal button context menu state
  const [terminalContextMenu, setTerminalContextMenu] = useState<{ x: number; y: number } | null>(null);
  const terminalContextMenuRef = useRef<HTMLDivElement>(null);

  // Close context menu when clicking outside
  useEffect(() => {
    if (!terminalContextMenu) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (terminalContextMenuRef.current && !terminalContextMenuRef.current.contains(e.target as Node)) {
        setTerminalContextMenu(null);
      }
    };

    const handleEscape = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setTerminalContextMenu(null);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [terminalContextMenu]);

  const handleTerminalContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setTerminalContextMenu({ x: e.clientX, y: e.clientY });
  }, []);

  const handleNewTerminalClick = useCallback(() => {
    setTerminalContextMenu(null);
    onCreateNewTerminal?.();
  }, [onCreateNewTerminal]);

  // A workstream has children if there are multiple sessions
  const hasChildren = sessions.length > 1;

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Update edit value when title changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditValue(title ?? '');
    }
  }, [title, isEditing]);

  const handleTitleClick = useCallback(() => {
    setEditValue(title ?? '');
    setIsEditing(true);
  }, [title]);

  const handleRenameSubmit = useCallback(async () => {
    const trimmedValue = editValue.trim();
    if (trimmedValue && trimmedValue !== title) {
      try {
        const result = await window.electronAPI.invoke('sessions:update-metadata', workstreamId, { title: trimmedValue });
        if (result.success) {
          const now = Date.now();
          // Update session with new title (syncs both sessionStoreAtom and sessionRegistryAtom)
          updateSessionStore({ sessionId: workstreamId, updates: { title: trimmedValue, updatedAt: now } });
        } else {
          console.error('[WorkstreamHeader] Failed to rename session:', result.error);
        }
      } catch (err) {
        console.error('[WorkstreamHeader] Error renaming session:', err);
      }
    }
    setIsEditing(false);
  }, [editValue, title, workstreamId, updateSessionStore]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      handleRenameSubmit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditValue(title ?? '');
      setIsEditing(false);
    }
  }, [handleRenameSubmit, title]);

  const handleLayoutChange = useCallback((mode: WorkstreamLayoutMode) => {
    setLayoutMode({ workstreamId, mode });
  }, [workstreamId, setLayoutMode]);

  // Determine session type label for archive and pin buttons
  const getSessionTypeLabel = useCallback(() => {
    if (worktreeId) return 'Worktree';
    if (hasChildren) return 'Workstream';
    return 'Session';
  }, [worktreeId, hasChildren]);

  // The header title stays the session title, so the chip shows the worktree's
  // own name (its directory/branch slug) — the one piece of worktree identity
  // that appears nowhere else in Agent mode. Falls back to the cached path so
  // the chip is populated before `worktree:get` resolves.
  const worktreeChipName = worktreeId
    ? (worktreeRecord?.name || (worktreePath ? getWorktreeNameFromPath(worktreePath, '') : ''))
    : '';

  // Pin state lives on the worktree record for worktrees and on the session
  // record otherwise — the same split the sidebar context menus use.
  const isPinned = worktreeId ? (worktreeRecord?.isPinned ?? false) : (sessionData?.isPinned ?? sessionMeta?.isPinned ?? false);

  const handlePinToggle = useCallback(async () => {
    try {
      await toggleWorkstreamHeaderPin({
        workstreamId,
        worktreeId,
        isPinned: !isPinned,
        invoke: window.electronAPI.invoke,
        patchWorktreeRecord,
        updateSessionStore,
        publishSessionPinnedUpdate,
      });
    } catch (error) {
      console.error('[WorkstreamHeader] Failed to toggle pin:', error);
    }
  }, [isPinned, worktreeId, workstreamId, patchWorktreeRecord, updateSessionStore, publishSessionPinnedUpdate]);

  const handleArchive = useCallback(async () => {
    // For worktrees, show confirmation dialog first
    if (worktreeId && onShowArchiveDialog) {
      onShowArchiveDialog();
      return;
    }

    if (!(await saveSessionArchived(workstreamId, true))) return;
    // Update atom state for immediate UI feedback across all components
    updateSessionStore({ sessionId: workstreamId, updates: { isArchived: true } });
    onArchiveStatusChange?.();
  }, [workstreamId, worktreeId, onArchiveStatusChange, onShowArchiveDialog, updateSessionStore]);

  const handleUnarchive = useCallback(async () => {
    if (!(await saveSessionArchived(workstreamId, false))) return;
    // Update atom state for immediate UI feedback across all components
    updateSessionStore({ sessionId: workstreamId, updates: { isArchived: false } });
    onArchiveStatusChange?.();
  }, [workstreamId, onArchiveStatusChange, updateSessionStore]);

  return (
    <div className="workstream-header shrink-0 h-14 px-4 border-b border-[var(--nim-border)] bg-[var(--nim-bg)]">
      <div className="workstream-header-main flex items-center gap-3 h-full">
        <div className="workstream-header-icon shrink-0 text-[var(--nim-text-muted)]" title={getSessionTypeLabel()}>
          {worktreeId ? (
            <WorktreeIcon size={20} />
          ) : hasChildren ? (
            <MaterialSymbol icon="account_tree" size={20} />
          ) : (
            <ProviderIcon provider={sessionData?.provider ?? sessionMeta?.provider ?? 'claude-code'} size={20} />
          )}
        </div>

        <div className="workstream-header-content flex flex-col min-w-0 flex-1 gap-0.5 items-start">
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              className="workstream-header-title-input text-sm font-semibold text-[var(--nim-text)] bg-[var(--nim-bg-secondary)] border border-[var(--nim-border-accent)] rounded py-0.5 px-1 m-0 outline-none w-full min-w-[150px] max-w-[500px]"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleRenameSubmit}
              onKeyDown={handleKeyDown}
            />
          ) : (
            <h2
              className="workstream-header-title max-w-full m-0 text-sm font-semibold text-[var(--nim-text)] whitespace-nowrap overflow-hidden text-ellipsis leading-tight cursor-pointer py-0.5 px-1 rounded transition-colors duration-150 hover:bg-[var(--nim-bg-hover)]"
              onClick={handleTitleClick}
              title="Click to rename"
            >
              {title}
            </h2>
          )}
          <div className="workstream-header-meta-row flex items-center gap-1.5 w-full min-w-0">
            {worktreeChipName && (
              <span
                className="workstream-header-worktree-chip shrink-0 flex items-center gap-1 max-w-[14rem] px-1.5 py-px rounded text-[0.625rem] font-medium text-[var(--nim-text-muted)] bg-[var(--nim-bg-secondary)] whitespace-nowrap overflow-hidden text-ellipsis"
                title={worktreePath ? `Worktree: ${worktreeChipName}\n${worktreePath}` : `Worktree: ${worktreeChipName}`}
              >
                <WorktreeIcon size={10} />
                {worktreeChipName}
              </span>
            )}
            <WorkstreamHeaderTagsRow workstreamId={workstreamId} />
          </div>
          <CoordinatorLink sessionId={activeSessionId ?? workstreamId} onOpen={onOpenSession} />
          <CoordinatedSessionsLinks sessionId={workstreamId} onOpen={onOpenSession} />
        </div>

        {isProcessing && (
          <div className="workstream-header-processing shrink-0 flex items-center justify-center">
            <span className="workstream-header-spinner w-4 h-4 border-2 border-[var(--nim-border)] border-t-[var(--nim-primary)] rounded-full animate-spin" />
          </div>
        )}

        {/* MCP servers for the session currently in view. Hides itself for
            providers with no MCP status channel and for sessions that have not
            run a turn yet, so a healthy or irrelevant session shows nothing. */}
        {activeSessionId && <ActiveSessionMcpStatusChip sessionId={activeSessionId} />}

        {/* Terminal button - only show for worktree sessions, positioned before layout controls */}
        {worktreeId && onOpenTerminal && (
          <button
            className="workstream-terminal-btn w-8 h-8 flex items-center justify-center rounded text-[var(--nim-text-faint)] cursor-pointer border-none bg-transparent hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)] mr-2"
            onClick={onOpenTerminal}
            onContextMenu={handleTerminalContextMenu}
            title="Open terminal in worktree"
          >
            <MaterialSymbol icon="terminal" size={20} />
          </button>
        )}

        {/* Terminal button context menu */}
        {terminalContextMenu && (
          <div
            ref={terminalContextMenuRef}
            className="fixed p-1 min-w-[140px] rounded-md z-[10000] text-[13px] backdrop-blur-[10px] shadow-[0_4px_12px_rgba(0,0,0,0.15)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.5)]"
            style={{
              left: terminalContextMenu.x,
              top: terminalContextMenu.y,
              background: 'var(--nim-bg)',
              border: '1px solid var(--nim-border)',
            }}
          >
            <div
              className="flex items-center gap-2.5 px-3 py-1.5 rounded cursor-pointer transition-colors text-[var(--nim-text)] hover:bg-[var(--nim-bg-hover)]"
              onClick={handleNewTerminalClick}
            >
              <MaterialSymbol icon="add" size={18} />
              <span>New Terminal</span>
            </div>
          </div>
        )}

        {/* Layout controls - shared component with Files/Agent labels */}
        {filePlacement === 'above' && (
          <LayoutControls mode={layoutMode} hasTabs={hasTabs} onModeChange={handleLayoutChange} />
        )}

        <ChatAppearanceControl />

        {/* Pin/Unpin toggle - routes to the worktree or the session per type */}
        <button
          className={`workstream-pin-button w-8 h-8 flex items-center justify-center rounded cursor-pointer border-none bg-transparent hover:bg-[var(--nim-bg-hover)] ${
            isPinned ? 'text-[var(--nim-primary)]' : 'text-[var(--nim-text-faint)] hover:text-[var(--nim-text-muted)]'
          }`}
          onClick={handlePinToggle}
          aria-pressed={isPinned}
          title={`${isPinned ? 'Unpin' : 'Pin'} ${getSessionTypeLabel().toLowerCase()}`}
        >
          <MaterialSymbol icon="push_pin" size={18} fill={isPinned} />
        </button>

        {/* Archive/Unarchive button */}
        <button
          className="workstream-archive-button flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-40 h-8 px-2 rounded text-[var(--nim-text-faint)] text-[11px] font-medium cursor-pointer border-none bg-transparent hover:bg-[var(--nim-bg-hover)] hover:text-[var(--nim-text-muted)]"
          onClick={isArchived ? handleUnarchive : handleArchive}
          disabled={archiveDisabled}
          title={archiveDisabled ? 'Worktree archiving is available in the desktop app' : `${isArchived ? 'Unarchive' : 'Archive'} ${getSessionTypeLabel().toLowerCase()}`}
        >
          <MaterialSymbol icon={isArchived ? 'unarchive' : 'archive'} size={18} />
          <span>{isArchived ? `Unarchive ${getSessionTypeLabel()}` : `Archive ${getSessionTypeLabel()}`}</span>
        </button>

      </div>
    </div>
  );
});

WorkstreamHeader.displayName = 'WorkstreamHeader';
