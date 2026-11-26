/**
 * AgentWorkstreamPanel - The right side of AgentMode.
 *
 * Displays the selected workstream which could be:
 * - A single session
 * - A workstream (parent + child sessions)
 * - A worktree (worktree + associated sessions)
 *
 * Layout:
 * - WorkstreamHeader (title, provider icon, processing state, layout controls)
 * - WorkstreamEditorTabs (top - file editors for the entire workstream)
 * - WorkstreamSessionTabs (bottom - session tabs + AgentSessionPanel)
 * - FilesEditedSidebar (right - shows files edited by AI)
 *
 * File editing is at the WORKSTREAM level, not per-session.
 * Clicking a file in any session's sidebar opens it in the workstream editor tabs.
 */

import React, { useCallback, useEffect, useRef, useState, useImperativeHandle, type KeyboardEvent } from 'react';
import { getWorktreeNameFromPath } from '../../utils/pathUtils';
import { useAtomValue, useSetAtom } from 'jotai';
import {
  MaterialSymbol,
  SearchReplaceStateManager,
} from '@nimbalyst/runtime';
import { ModelIdentifier } from '@nimbalyst/runtime/ai/server/types';
import type { TranscriptFileLocation } from '@nimbalyst/runtime/ui/AgentTranscript/components/MarkdownRenderer';
import { revealEditorPosition } from '../TabEditor/editorRevealCommand';
import { openFileAsWikiPage } from '../../utils/agentEditedPage';
import { AgentWorkstreamLayout } from './AgentWorkstreamLayout';
import { agentFilePlacementAtom } from '../../store/atoms/agentFilePlacement';
import { fileViewerWidthAtom, revealWorkstreamEditorAtom } from '../../store/atoms/agentFileViewer';
import { WorkstreamEditorTabs, type WorkstreamEditorTabsRef } from './WorkstreamEditorTabs';
import { usePushRepresentedFile } from '../../hooks/useRepresentedFileSync';
import { resolveRepresentedFile } from '../../utils/representedFile';
import { saveSessionArchived } from '../../utils/saveSessionArchived';
import { NO_WORKTREE_KEY, WorkstreamHeader } from './WorkstreamHeader';
import { WorkstreamSessionTabs } from './WorkstreamSessionTabs';
import { FilesEditedSidebar } from './FilesEditedSidebar';
import { AgentReviewPanel } from './AgentReviewPanel';
import { ChatSidebar } from '../ChatSidebar/ChatSidebar';
import {
  worktreeRecordAtom,
  setWorktreeRecordAtom,
} from '../../store/atoms/worktrees';
import {
  workstreamSessionsAtom,
  sessionStoreAtom,
  sessionRegistryAtom,
  sessionParentIdDerivedAtom,
  sessionWorktreeIdAtom,
  loadSessionChildrenAtom,
  loadSessionDataAtom,
  updateSessionStoreAtom,
  setActiveSessionInWorkstreamAtom,
  refreshSessionListAtom,
  type WorkstreamType,
} from '../../store';
import {
  workstreamStateAtom,
  workstreamActiveChildAtom,
  workstreamLayoutModeAtom,
  workstreamSplitRatioAtom,
  workstreamFilesSidebarVisibleAtom,
  workstreamRightPanelModeAtom,
  workstreamSessionChatIdsAtom,
  workstreamHasOpenResourcesAtom,
  setWorkstreamLayoutModeAtom,
  setWorkstreamSplitRatioAtom,
  setWorkstreamSessionChatIdAtom,
  toggleWorkstreamFilesSidebarAtom,
  loadWorkstreamState,
  workstreamStatesLoadedAtom,
  workstreamWorktreePathAtom,
  workstreamActiveFileAtom,
  type WorkstreamLayoutMode,
} from '../../store/atoms/workstreamState';
import {
  filesEditedWidthAtom,
  setFilesEditedWidthAtom,
  clampAgentRightPanelWidth,
  sessionHistoryCollapsedAtom,
  toggleSessionHistoryCollapsedAtom,
} from '../../store/atoms/agentMode';
import { useEditorMaximize } from '../../hooks/useEditorMaximize';
import { useResizeDragShield } from '../../hooks/useResizeDragShield';
import { ArchiveWorktreeDialog } from './ArchiveWorktreeDialog';
import { useArchiveWorktreeDialog } from '../../hooks/useArchiveWorktreeDialog';
import { detectFileType, type SerializableDocumentContext } from '../../hooks/useDocumentContext';
import { getTextSelection } from '../UnifiedAI/TextSelectionIndicator';
import { terminalListAtom, terminalListWorkspaceAtom, terminalsForWorkspace, setActiveTerminal, loadTerminals } from '../../store/atoms/terminals';
import { defaultAgentModelAtom } from '../../store/atoms/appSettings';

export interface AgentWorkstreamPanelRef {
  closeActiveTab: () => void;
  toggleEditorMaximized: () => void;
}

export interface AgentWorkstreamPanelProps {
  workspacePath: string;
  workstreamId: string;
  workstreamType: WorkstreamType;
  isActive: boolean;
  onFileOpen?: (filePath: string) => Promise<void>;
  onAddSessionToWorktree?: (worktreeId: string) => Promise<void>;
  onCreateWorktreeSession?: (worktreeId: string) => Promise<string | null>;
  /** Callback when a worktree is archived */
  onWorktreeArchived?: () => void;
  /** Whether the workspace is a git repository */
  isGitRepo?: boolean;
  /** Open a session in agent mode (navigates to session tab) */
  onSwitchToAgentMode?: (planDocumentPath?: string, sessionId?: string) => void;
  /** Open a session in the chat sidebar */
  onOpenSessionInChat?: (sessionId: string) => void;
}

const pairedChatCreationPromises = new Map<string, Promise<string | null>>();

function sessionMentionDraft(sessionId: string, sessionTitle: string): string {
  const safeTitle = (sessionTitle.trim() || 'Session')
    .replace(/[\r\n[\]]+/g, ' ')
    .trim();
  return `Regarding @@[${safeTitle}](${sessionId}): `;
}

async function createPairedStandardChat({
  workspacePath,
  targetSessionId,
  targetSessionTitle,
  defaultModel,
}: {
  workspacePath: string;
  targetSessionId: string;
  targetSessionTitle: string;
  defaultModel: string | null;
}): Promise<string | null> {
  const chatSessionId = crypto.randomUUID();
  const modelId = defaultModel ? ModelIdentifier.tryParse(defaultModel) : null;
  const provider = modelId?.provider || 'claude-code';
  const cleanTitle = targetSessionTitle.trim() || 'Session';
  const result = await window.electronAPI.invoke('sessions:create', {
    session: {
      id: chatSessionId,
      provider,
      model: defaultModel,
      title: `Chat with ${cleanTitle}`.slice(0, 120),
    },
    workspaceId: workspacePath,
  });

  if (!result?.success) return null;

  try {
    await window.electronAPI.invoke(
      'sessions:update-draft-input',
      chatSessionId,
      sessionMentionDraft(targetSessionId, cleanTitle),
    );
  } catch (error) {
    // The session already exists. Preserve its pairing even if draft seeding
    // races a reconnect; creating a replacement would leave duplicate chats.
    console.warn('[AgentWorkstreamPanel] Failed to seed paired chat draft:', error);
  }
  return chatSessionId;
}

/**
 * AgentWorkstreamPanel renders the selected workstream.
 *
 * File clicks open in the workstream-level editor tabs, not per-session.
 */
export const AgentWorkstreamPanel = React.memo(React.forwardRef<AgentWorkstreamPanelRef, AgentWorkstreamPanelProps>(({
  workspacePath,
  workstreamId,
  workstreamType,
  isActive,
  onFileOpen,
  onAddSessionToWorktree,
  onCreateWorktreeSession,
  onWorktreeArchived,
  isGitRepo = false,
  onSwitchToAgentMode,
  onOpenSessionInChat,
}, ref) => {
  // Ref to the workstream editor tabs for opening files
  const editorTabsRef = useRef<WorkstreamEditorTabsRef>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const rightPanelRef = useRef<HTMLDivElement>(null);

  // Get sessions in this workstream
  const sessions = useAtomValue(workstreamSessionsAtom(workstreamId));
  const activeSessionId = useAtomValue(workstreamActiveChildAtom(workstreamId));
  const setActiveSession = useSetAtom(setActiveSessionInWorkstreamAtom);

  // Worktree state - read cached worktree path from atom (available synchronously on remount)
  const worktreePath = useAtomValue(workstreamWorktreePathAtom(workstreamId));
  const setWorkstreamState = useSetAtom(workstreamStateAtom(workstreamId));
  const sessionParentId = useAtomValue(sessionParentIdDerivedAtom(workstreamId));
  const sessionWorktreeId = useAtomValue(sessionWorktreeIdAtom(workstreamId));
  const worktreeRecord = useAtomValue(worktreeRecordAtom(sessionWorktreeId ?? NO_WORKTREE_KEY));
  const setWorktreeRecord = useSetAtom(setWorktreeRecordAtom);

  // Debug: log when activeSessionId changes
  // useEffect(() => {
  //   console.log(`[AgentWorkstreamPanel] activeSessionId changed for ${workstreamId}:`, activeSessionId);
  // }, [workstreamId, activeSessionId]);

  // Layout state (persisted via workstreamStateAtom)
  const layoutMode = useAtomValue(workstreamLayoutModeAtom(workstreamId));
  const filePlacement = useAtomValue(agentFilePlacementAtom);
  const sidebarVisible = useAtomValue(workstreamFilesSidebarVisibleAtom(workstreamId));
  const rightPanelMode = useAtomValue(workstreamRightPanelModeAtom(workstreamId));
  const sessionChatSessionIds = useAtomValue(workstreamSessionChatIdsAtom(workstreamId));
  const splitRatio = useAtomValue(workstreamSplitRatioAtom(workstreamId));
  const hasTabs = useAtomValue(workstreamHasOpenResourcesAtom(workstreamId));
  const toggleSidebar = useSetAtom(toggleWorkstreamFilesSidebarAtom);
  const setSplitRatio = useSetAtom(setWorkstreamSplitRatioAtom);
  const setLayoutMode = useSetAtom(setWorkstreamLayoutModeAtom);
  const setSessionChatId = useSetAtom(setWorkstreamSessionChatIdAtom);
  const refreshSessions = useSetAtom(refreshSessionListAtom);
  const defaultModel = useAtomValue(defaultAgentModelAtom);

  // Files sidebar width (project-level state from agentMode)
  const auxiliaryWidth = useAtomValue(filesEditedWidthAtom);
  const fileViewerWidth = useAtomValue(fileViewerWidthAtom(workstreamId));
  const viewerSelected = rightPanelMode === 'file-viewer';
  const sidebarWidth = viewerSelected ? (fileViewerWidth ?? '45%') : auxiliaryWidth;
  const revealEditor = useSetAtom(revealWorkstreamEditorAtom);
  const worktreePathReady = !sessionWorktreeId || !!worktreePath;
  const showEditorTabs = worktreePathReady && (layoutMode === 'editor' || (filePlacement === 'right'
    ? sidebarVisible && viewerSelected : layoutMode === 'split'));
  const setSidebarWidth = useSetAtom(setFilesEditedWidthAtom);
  const chatTargetId = activeSessionId || (workstreamType === 'session' ? workstreamId : null);
  const chatTargetSession = useAtomValue(sessionStoreAtom(chatTargetId || '__no_chat_target__'));
  const chatTargetTitle = chatTargetSession?.title || 'Session';
  const chatSessionId = chatTargetId ? sessionChatSessionIds[chatTargetId] ?? null : null;
  const [chatCreationError, setChatCreationError] = useState<string | null>(null);
  const [chatCreationAttempt, setChatCreationAttempt] = useState(0);

  const handleChatSessionChange = useCallback((nextChatSessionId: string | null) => {
    if (!chatTargetId) return;
    setSessionChatId({
      workstreamId,
      targetSessionId: chatTargetId,
      chatSessionId: nextChatSessionId,
    });
  }, [chatTargetId, setSessionChatId, workstreamId]);

  useEffect(() => {
    if (
      !isActive
      || !sidebarVisible
      || rightPanelMode !== 'session-chat'
      || !chatTargetId
      || chatSessionId
    ) {
      return;
    }

    let cancelled = false;
    const creationKey = `${workspacePath}\0${workstreamId}\0${chatTargetId}`;
    let creation = pairedChatCreationPromises.get(creationKey);
    if (!creation) {
      creation = createPairedStandardChat({
        workspacePath,
        targetSessionId: chatTargetId,
        targetSessionTitle: chatTargetTitle,
        defaultModel,
      });
      pairedChatCreationPromises.set(creationKey, creation);
      const clearCreation = () => {
        if (pairedChatCreationPromises.get(creationKey) === creation) {
          pairedChatCreationPromises.delete(creationKey);
        }
      };
      void creation.then(clearCreation, clearCreation);
    }

    setChatCreationError(null);
    void creation
      .then((createdSessionId) => {
        if (!createdSessionId) {
          if (!cancelled) {
            setChatCreationError('Could not open a chat for this session.');
          }
          return;
        }
        // Persist the target pairing even if the panel remounted or the user
        // switched sessions while creation was in flight.
        setSessionChatId({
          workstreamId,
          targetSessionId: chatTargetId,
          chatSessionId: createdSessionId,
        });
        refreshSessions();
      })
      .catch((error) => {
        console.error('[AgentWorkstreamPanel] Failed to create paired chat:', error);
        if (!cancelled) {
          setChatCreationError('Could not open a chat for this session.');
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    chatCreationAttempt,
    chatSessionId,
    chatTargetId,
    chatTargetTitle,
    defaultModel,
    isActive,
    refreshSessions,
    rightPanelMode,
    setSessionChatId,
    sidebarVisible,
    workspacePath,
    workstreamId,
  ]);

  // Session store for updating archived state
  const updateSessionStore = useSetAtom(updateSessionStoreAtom);

  // Session history collapse (global agent-mode sidebar) for full-window maximize
  const sessionHistoryCollapsed = useAtomValue(sessionHistoryCollapsedAtom);
  const toggleSessionHistory = useSetAtom(toggleSessionHistoryCollapsedAtom);

  // Double-click a tab to maximize the editor to the whole window: hide the
  // transcript (layoutMode 'editor'), the files-edited sidebar, and the
  // session-history sidebar. Second double-click restores the exact prior
  // layout, including a viewer docked on the right.
  const { isMaximized: isEditorMaximized, toggle: toggleEditorMaximized, clearMaximize: clearEditorMaximized } =
    useEditorMaximize<{ layoutMode: WorkstreamLayoutMode; filesSidebar: boolean; historyCollapsed: boolean }>({
      scopeKey: workstreamId,
      snapshot: () => ({ layoutMode, filesSidebar: sidebarVisible, historyCollapsed: sessionHistoryCollapsed }),
      maximize: () => {
        setLayoutMode({ workstreamId, mode: 'editor' });
        if (sidebarVisible) toggleSidebar(workstreamId);
        if (!sessionHistoryCollapsed) toggleSessionHistory();
      },
      restore: (snap) => {
        setLayoutMode({ workstreamId, mode: snap.layoutMode });
        if (sidebarVisible !== snap.filesSidebar) toggleSidebar(workstreamId);
        if (sessionHistoryCollapsed !== snap.historyCollapsed) toggleSessionHistory();
      },
    });

  // Drop the stale restore snapshot if the maximized layout is broken by a
  // manual panel toggle (or the auto-switch to transcript when the last tab
  // closes), so the next double-click re-maximizes from the current layout.
  useEffect(() => {
    if (isEditorMaximized && !(layoutMode === 'editor' && !sidebarVisible && sessionHistoryCollapsed)) {
      clearEditorMaximized();
    }
  }, [isEditorMaximized, layoutMode, sidebarVisible, sessionHistoryCollapsed, clearEditorMaximized]);

  // Load persisted state when workstream changes
  useEffect(() => {
    loadWorkstreamState(workstreamId);
  }, [workstreamId]);

  // Collapse only after the last live tab closes. A hidden, mounted editor can
  // receive an open before its tab mirror updates; an empty snapshot during
  // that transition must not undo the reveal.
  const previouslyHadTabs = useRef(hasTabs);
  useEffect(() => {
    if (previouslyHadTabs.current && !hasTabs) {
      setLayoutMode({ workstreamId, mode: 'transcript' });
    }
    previouslyHadTabs.current = hasTabs;
  }, [hasTabs, workstreamId, setLayoutMode]);

  // Load session data and children when workstream changes
  // This is critical for workstreams with child sessions to work properly
  const loadSessionData = useSetAtom(loadSessionDataAtom);
  const loadSessionChildren = useSetAtom(loadSessionChildrenAtom);

  // Get session data to check if it's been loaded
  const sessionDataLoaded = useAtomValue(sessionStoreAtom(workstreamId));

  // Wait for workstream states to be loaded from disk before loading children
  // This prevents race conditions where children load before persisted activeChildId is restored
  const workstreamStatesLoaded = useAtomValue(workstreamStatesLoadedAtom);

  // Track which workstreams have had their children loaded to prevent re-loading
  // on session data updates (which would reset activeChildId and cause focus stealing)
  const childrenLoadedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!workstreamId || !workspacePath) return;

    // Load session data if not already loaded
    // sessionDataLoaded is null when no data has been fetched yet
    if (sessionDataLoaded === null) {
      // console.log('[AgentWorkstreamPanel] Session data not loaded, fetching for:', workstreamId);
      loadSessionData({ sessionId: workstreamId, workspacePath });
    }
  }, [workstreamId, workspacePath, sessionDataLoaded, loadSessionData]);

  useEffect(() => {
    // Wait for both session data AND workstream states to be loaded before loading children
    // This ensures persisted activeChildId is available when loadSessionChildrenAtom runs
    if (!workstreamId || !workspacePath || sessionDataLoaded === null || !workstreamStatesLoaded) {
      // console.log('[AgentWorkstreamPanel] Children effect - waiting for:', {
      //   workstreamId: !!workstreamId,
      //   workspacePath: !!workspacePath,
      //   sessionDataLoaded: sessionDataLoaded !== null,
      //   workstreamStatesLoaded,
      // });
      return;
    }

    // Only load children once per workstream to prevent focus stealing
    // When session data updates (e.g., new messages), we don't want to reload children
    // because loadSessionChildrenAtom resets activeChildId which causes the active tab to change
    if (childrenLoadedRef.current.has(workstreamId)) {
      return;
    }

    // Load child sessions for this workstream
    // This populates sessionChildrenAtom which workstreamSessionsAtom depends on
    // sessionParentId === null means this IS a root session (not a child of another session)
    if (sessionParentId === null) {
      // This is a root session - load its children
      // console.log('[AgentWorkstreamPanel] Loading children for root session:', workstreamId);
      loadSessionChildren({ parentSessionId: workstreamId, workspacePath });
      childrenLoadedRef.current.add(workstreamId);
    }
  }, [workstreamId, workspacePath, sessionDataLoaded, sessionParentId, workstreamStatesLoaded, loadSessionChildren]);

  // Resolve the worktree if this is a worktree session and not yet cached.
  // `worktreePath` is persisted with the workstream, but the record (name, pin
  // state) is renderer-only, so a fresh launch needs the fetch even when the
  // path is already known.
  useEffect(() => {
    if (!sessionWorktreeId) {
      if (worktreePath) {
        setWorkstreamState({ worktreePath: null });
      }
      return;
    }

    if (worktreePath && worktreeRecord) return;

    (async () => {
      try {
        const result = await window.electronAPI.invoke('worktree:get', sessionWorktreeId);
        if (result?.success && result.worktree) {
          const worktree = result.worktree;
          if (!worktreePath) {
            setWorkstreamState({ worktreePath: worktree.path });
          }
          setWorktreeRecord({
            id: sessionWorktreeId,
            name: worktree.name,
            displayName: worktree.displayName ?? null,
            path: worktree.path,
            isPinned: worktree.isPinned ?? false,
          });
        } else {
          console.error('[AgentWorkstreamPanel] Failed to resolve worktree:', result?.error);
        }
      } catch (error) {
        console.error('[AgentWorkstreamPanel] Error resolving worktree:', error);
      }
    })();
  }, [sessionWorktreeId, worktreePath, worktreeRecord, setWorkstreamState, setWorktreeRecord]);

  // Local state for drag states
  const [isDraggingVertical, setIsDraggingVertical] = useState(false);
  const [isDraggingSidebar, setIsDraggingSidebar] = useState(false);

  // Archive worktree dialog hook
  const {
    dialogState: archiveDialogState,
    showDialog: showArchiveDialog,
    closeDialog: closeArchiveDialog,
    confirmArchive,
  } = useArchiveWorktreeDialog();

  // Ref for the content container (used for resize calculations)
  const verticalResizeRef = useRef({ startY: 0, startRatio: splitRatio, containerHeight: 0 });
  const sidebarResizeRef = useRef({
    startX: 0,
    startWidth: auxiliaryWidth,
    availableWidth: 0,
  });

  // Ref for the editor area to check focus
  const editorAreaRef = useRef<HTMLDivElement>(null);

  // Ref for the session/transcript area to check focus
  const sessionAreaRef = useRef<HTMLDivElement>(null);

  // Track which panel (editor vs session) was last clicked/focused.
  // Used by CMD+F to determine where to route find, since document.activeElement
  // is unreliable (e.g., clicking a tab bar or non-focusable area doesn't set activeElement
  // inside the editor area). Defaults to 'session' since that's the primary panel.
  const lastFocusedPanelRef = useRef<'editor' | 'session'>('session');

  // For single sessions, activeSessionId should be the session itself
  // For workstreams, activeSessionId should be one of the children
  // We trust the atom state - no fallback that masks bugs

  const handleSessionSelect = useCallback((sessionId: string) => {
    setActiveSession({ workstreamId, sessionId });
  }, [workstreamId, setActiveSession]);

  // Archive a child session
  const handleSessionArchive = useCallback(async (sessionId: string) => {
    if (!(await saveSessionArchived(sessionId, true))) return;
    updateSessionStore({ sessionId, updates: { isArchived: true } });
  }, [updateSessionStore]);

  // Unarchive a child session
  const handleSessionUnarchive = useCallback(async (sessionId: string) => {
    if (!(await saveSessionArchived(sessionId, false))) return;
    updateSessionStore({ sessionId, updates: { isArchived: false } });
  }, [updateSessionStore]);

  // Rename a session
  // If this is a worktree with only one session, also rename the worktree to keep them in sync
  const handleSessionRename = useCallback(async (sessionId: string, newName: string) => {
    try {
      console.log('[AgentWorkstreamPanel] Renaming session', { sessionId, newName, sessionWorktreeId, sessionsLength: sessions.length });
      const result = await window.electronAPI.invoke('sessions:update-metadata', sessionId, { title: newName });
      if (result.success) {
        const now = Date.now();
        updateSessionStore({ sessionId, updates: { title: newName, updatedAt: now } });

        // If this is a single-session worktree, also rename the worktree
        if (sessionWorktreeId && sessions.length === 1) {
          console.log('[AgentWorkstreamPanel] Also renaming worktree', { sessionWorktreeId, newName });
          const worktreeResult = await window.electronAPI.invoke('worktree:update-display-name', sessionWorktreeId, newName);
          console.log('[AgentWorkstreamPanel] Worktree rename result', worktreeResult);
        }
      } else {
        console.error('[AgentWorkstreamPanel] Failed to rename session:', result.error);
      }
    } catch (error) {
      console.error('[AgentWorkstreamPanel] Error renaming session:', error);
    }
  }, [updateSessionStore, sessionWorktreeId, sessions.length]);

  // Track pending file open when switching to split mode. Carries the line
  // location too, so a `file.md:653` link survives the layout flip.
  const pendingFileOpenRef = useRef<{ filePath: string; location?: TranscriptFileLocation } | null>(null);

  // File clicks open in the workstream editor tabs, except a Local wiki page,
  // which opens in Pages.
  const handleFileClick = useCallback(async (filePath: string, location?: TranscriptFileLocation) => {
    if (await openFileAsWikiPage(filePath, workspacePath, 'agent_tool')) {
      if (location) revealEditorPosition(filePath, location);
      return;
    }
    revealEditor(workstreamId);
    if (editorTabsRef.current) {
      // Editor is mounted, open the file directly
      editorTabsRef.current.openFile(filePath, location);
    } else {
      // The worktree path is still resolving; replay after its editor mounts.
      pendingFileOpenRef.current = { filePath, location };
    }
  }, [workspacePath, workstreamId, revealEditor]);

  // Get document context from the workstream editor tabs (for AI selection/file context)
  // This is called on-demand when sending a message to capture fresh selection state
  const getDocumentContext = useCallback(async (): Promise<SerializableDocumentContext> => {
    const activeTab = showEditorTabs ? editorTabsRef.current?.getActiveTab() : null;
    if (!activeTab) {
      return {
        filePath: undefined,
        content: undefined,
        fileType: undefined,
        textSelection: undefined,
        textSelectionTimestamp: undefined,
      };
    }

    const fileType = detectFileType(activeTab.filePath);

    // Get text selection if it matches the current file
    const textSelectionData = getTextSelection();
    const textSelection = textSelectionData && textSelectionData.filePath === activeTab.filePath
      ? textSelectionData
      : undefined;

    // Get mockup fields if viewing a mockup
    const mockupSelection = fileType === 'mockup' ? (window as any).__mockupSelectedElement : undefined;
    const mockupDrawing = fileType === 'mockup' ? (window as any).__mockupDrawing : undefined;

    return {
      filePath: activeTab.filePath,
      content: activeTab.content,
      fileType,
      textSelection,
      textSelectionTimestamp: textSelection?.timestamp,
      mockupSelection,
      mockupDrawing,
    };
  }, [showEditorTabs]);

  // Archive dialog handler
  const handleShowArchiveDialog = useCallback(async () => {
    if (!sessionWorktreeId || !worktreePath) return;
    const autoArchived = await showArchiveDialog({
      worktreeId: sessionWorktreeId,
      worktreeName: getWorktreeNameFromPath(worktreePath, 'worktree'),
      worktreePath,
      workspacePath,
    });
    if (autoArchived) {
      onWorktreeArchived?.();
    }
  }, [sessionWorktreeId, worktreePath, showArchiveDialog, workspacePath, onWorktreeArchived]);

  const handleConfirmArchive = useCallback(async () => {
    await confirmArchive(workspacePath, onWorktreeArchived);
  }, [workspacePath, onWorktreeArchived, confirmArchive]);

  // Get terminal list for checking existing terminals. Right after a project
  // switch the shared list still holds the old project's terminals (#1818).
  const loadedTerminals = useAtomValue(terminalListAtom);
  const terminalListWorkspace = useAtomValue(terminalListWorkspaceAtom);
  const terminals = terminalsForWorkspace(loadedTerminals, terminalListWorkspace, workspacePath);

  // Open a terminal in the worktree directory (reuses existing if available)
  const handleOpenTerminal = useCallback(async () => {
    if (!sessionWorktreeId || !worktreePath) return;

    // Check if there's already a terminal for this worktree
    const existingTerminal = terminals.find(t => t.worktreeId === sessionWorktreeId);
    if (existingTerminal) {
      // Reuse existing terminal - activate it and show panel
      setActiveTerminal(existingTerminal.id);
      await window.electronAPI.terminal.setActive(workspacePath, existingTerminal.id);
      window.dispatchEvent(new CustomEvent('terminal:show'));
      // Dispatch event to trigger focus animation on the terminal tab
      window.dispatchEvent(new CustomEvent('terminal:focused', {
        detail: { terminalId: existingTerminal.id }
      }));
      return;
    }

    // No existing terminal, create a new one
    try {
      const result = await window.electronAPI.terminal.create(workspacePath, {
        cwd: worktreePath,
        worktreeId: sessionWorktreeId,
        title: `Terminal (${getWorktreeNameFromPath(worktreePath)})`,
        source: 'worktree',
      });

      if (result.success && result.terminalId) {
        // Dispatch event to notify TerminalBottomPanel about the new terminal
        window.dispatchEvent(new CustomEvent('terminal:created', {
          detail: { terminalId: result.terminalId }
        }));
        // Dispatch event to notify App.tsx to show terminal panel
        window.dispatchEvent(new CustomEvent('terminal:show'));
      }
    } catch (error) {
      console.error('[AgentWorkstreamPanel] Failed to create terminal:', error);
    }
  }, [workspacePath, sessionWorktreeId, worktreePath, terminals]);

  // Create a new terminal (for right-click context menu)
  const handleCreateNewTerminal = useCallback(async () => {
    if (!sessionWorktreeId || !worktreePath) return;

    try {
      const result = await window.electronAPI.terminal.create(workspacePath, {
        cwd: worktreePath,
        worktreeId: sessionWorktreeId,
        title: `Terminal (${getWorktreeNameFromPath(worktreePath)})`,
        source: 'worktree',
      });

      if (result.success && result.terminalId) {
        window.dispatchEvent(new CustomEvent('terminal:created', {
          detail: { terminalId: result.terminalId }
        }));
        window.dispatchEvent(new CustomEvent('terminal:show'));
      }
    } catch (error) {
      console.error('[AgentWorkstreamPanel] Failed to create terminal:', error);
    }
  }, [workspacePath, sessionWorktreeId, worktreePath]);

  // Determine what to show based on layout mode
  // Editor tabs are shown in editor and split modes, but wait for worktree path to resolve
  // before rendering (TabContent captures workspaceId permanently on first render)
  // Session tabs are always shown - in editor mode, the transcript is collapsed but tabs + input remain visible
  const showSessionTabs = true;
  // Collapse the transcript content (hide messages) when in editor mode
  const collapseTranscript = layoutMode === 'editor';

  // Reactive file path of the active workstream editor tab, so the agent chat
  // scopes its "+ selection" chips to the file the user is actually looking at.
  // SelectionChips shows a chip only when currentFilePath matches the selection's
  // filePath (no most-recent fallback — that leaked a selection across modes).
  // The editor tabs live inside WorkstreamEditorTabs' own TabsProvider; the active
  // file is mirrored to workstreamState, so workstreamActiveFileAtom is null when
  // the active tab is a tracker (not a file) or nothing is open. Empty when the
  // editor area is hidden (transcript-only view) so a stale selection can't leak.
  // The send path still uses getDocumentContext for the fresh selection.
  const activeEditorFile = useAtomValue(workstreamActiveFileAtom(workstreamId));
  // Stable object identity (only changes when the active file does) so the memoized
  // WorkstreamSessionTabs / AgentSessionPanel aren't re-rendered every parent render.
  const sessionDocumentContext = React.useMemo(
    () => ({ filePath: showEditorTabs ? (activeEditorFile ?? '') : '' }),
    [showEditorTabs, activeEditorFile]
  );

  // #1375: report the visible document to macOS as this window's AXDocument.
  // Visibility belongs to the layout; hidden editors remain mounted to preserve state.
  usePushRepresentedFile(
    isActive,
    showEditorTabs ? resolveRepresentedFile(activeEditorFile) : null
  );

  // Open pending file once editor mounts after layout mode change
  useEffect(() => {
    const pending = pendingFileOpenRef.current;
    if (pending && showEditorTabs && editorTabsRef.current) {
      editorTabsRef.current.openFile(pending.filePath, pending.location);
      pendingFileOpenRef.current = null;
    }
  }, [showEditorTabs]); // Re-run when editor becomes visible

  // Resizers use a host-level shield so pointer input cannot be swallowed by
  // an iframe-backed editor in the workstream's top tab area.
  const startVerticalResizeDrag = useResizeDragShield({
    cursor: 'ns-resize',
    onMove: (event) => {
      const { startY, startRatio, containerHeight } = verticalResizeRef.current;
      const deltaY = event.clientY - startY;
      const currentHeight = startRatio * containerHeight;
      const newHeight = currentHeight + deltaY;
      const newRatio = newHeight / containerHeight;
      const clampedRatio = Math.max(0.1, Math.min(0.9, newRatio));
      setSplitRatio({ workstreamId, ratio: clampedRatio });
    },
    onEnd: () => {
      setIsDraggingVertical(false);
    },
  });

  const handleVerticalResizeStart = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const container = panelRef.current;
    if (!container) return;
    verticalResizeRef.current = {
      startY: event.clientY,
      startRatio: splitRatio,
      containerHeight: container.getBoundingClientRect().height,
    };
    setIsDraggingVertical(true);
    startVerticalResizeDrag(event);
  }, [splitRatio, startVerticalResizeDrag]);

  // Sidebar resizer (between content and sidebar)
  const startSidebarResizeDrag = useResizeDragShield({
    cursor: 'ew-resize',
    onMove: (event) => {
      const deltaX = sidebarResizeRef.current.startX - event.clientX;
      const newWidth = sidebarResizeRef.current.startWidth + deltaX;
      const width = clampAgentRightPanelWidth(newWidth, sidebarResizeRef.current.availableWidth);
      if (viewerSelected) setWorkstreamState({ fileViewerWidth: width });
      else setSidebarWidth(width);
    },
    onEnd: () => {
      setIsDraggingSidebar(false);
    },
  });

  const handleSidebarResizeStart = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    const availableWidth = panelRef.current?.getBoundingClientRect().width ?? auxiliaryWidth;
    const renderedPanel = viewerSelected ? editorAreaRef.current : rightPanelRef.current;
    const renderedWidth = renderedPanel?.getBoundingClientRect().width ?? auxiliaryWidth;
    sidebarResizeRef.current = {
      startX: event.clientX,
      startWidth: renderedWidth,
      availableWidth,
    };
    setIsDraggingSidebar(true);
    startSidebarResizeDrag(event);
  }, [auxiliaryWidth, viewerSelected, startSidebarResizeDrag]);

  // Track which panel was last clicked to route CMD+F correctly.
  // document.activeElement is unreliable because clicking tab bars, non-focusable
  // areas, or scrolling in the editor area doesn't necessarily move activeElement
  // into that area. mousedown on the panel container is a reliable proxy.
  useEffect(() => {
    const editorArea = editorAreaRef.current;
    const sessionArea = sessionAreaRef.current;

    const handleEditorClick = () => { lastFocusedPanelRef.current = 'editor'; };
    const handleSessionClick = () => { lastFocusedPanelRef.current = 'session'; };

    editorArea?.addEventListener('mousedown', handleEditorClick, true);
    sessionArea?.addEventListener('mousedown', handleSessionClick, true);

    return () => {
      editorArea?.removeEventListener('mousedown', handleEditorClick, true);
      sessionArea?.removeEventListener('mousedown', handleSessionClick, true);
    };
  }, [showEditorTabs, showSessionTabs]);

  // Trigger find in the active editor. Two strategies based on editor type:
  // - Monaco: dispatch synthetic Cmd+F keydown to its internal textarea, which
  //   Monaco's keybinding system processes to open its built-in find widget.
  // - Lexical: use SearchReplaceStateManager.openAndFocus() directly (same as Files mode).
  //   We can't use synthetic keydown because Lexical's SearchReplacePlugin checks
  //   isEditorActive (based on React state), which won't be true synchronously
  //   after focusing the contenteditable.
  const triggerEditorFind = useCallback(() => {
    const editorArea = editorAreaRef.current;
    if (!editorArea) {
      console.log('[AgentWorkstreamPanel] triggerEditorFind: no editorArea ref');
      return;
    }

    const monacoTextarea = editorArea.querySelector<HTMLTextAreaElement>('.monaco-editor .inputarea textarea');

    if (monacoTextarea) {
      console.log('[AgentWorkstreamPanel] triggerEditorFind: dispatching to Monaco textarea');
      monacoTextarea.focus();
      monacoTextarea.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'f', code: 'KeyF', metaKey: true,
        bubbles: true, cancelable: true,
      }));
    } else {
      // Lexical or other editor - use SearchReplaceStateManager
      const activeFilePath = editorTabsRef.current?.getActiveFilePath();
      if (activeFilePath) {
        console.log('[AgentWorkstreamPanel] triggerEditorFind: opening SearchReplaceStateManager for', activeFilePath);
        SearchReplaceStateManager.openAndFocus(activeFilePath);
      } else {
        console.log('[AgentWorkstreamPanel] triggerEditorFind: no active file path');
      }
    }
  }, []);

  // Dispatch find-next/find-prev keyboard events to the active editor.
  // These only work when the editor already has focus (find dialog is open).
  const dispatchEditorKeyEvent = useCallback((key: string, code: string, meta: boolean, shift = false) => {
    const editorArea = editorAreaRef.current;
    if (!editorArea) return;

    const monacoTextarea = editorArea.querySelector<HTMLTextAreaElement>('.monaco-editor .inputarea textarea');
    const target = monacoTextarea || document;

    target.dispatchEvent(new KeyboardEvent('keydown', {
      key, code, metaKey: meta, shiftKey: shift,
      bubbles: true, cancelable: true,
    }));
  }, []);

  // Handle CMD+F routing based on which panel was last interacted with.
  // Editor panel: triggerEditorFind handles Monaco vs Lexical differently.
  // Session panel: dispatch transcript:find CustomEvent.
  useEffect(() => {
    if (!isActive) return;
    const handleFind = () => {
      const activeFilePath = editorTabsRef.current?.getActiveFilePath();
      const editorIsTarget = showEditorTabs && lastFocusedPanelRef.current === 'editor' && activeFilePath;

      console.log('[AgentWorkstreamPanel] handleFind: lastFocusedPanel=' + lastFocusedPanelRef.current +
        ' activeFilePath=' + activeFilePath + ' activeSessionId=' + activeSessionId);

      if (editorIsTarget) {
        triggerEditorFind();
      } else if (activeSessionId) {
        window.dispatchEvent(new CustomEvent('transcript:find', {
          detail: { sessionId: activeSessionId }
        }));
      }
    };

    // An open Lexical find bar takes Find Next / Previous directly; it has no
    // Cmd+G key handler, so the synthetic keydown only reaches Monaco (#1578).
    const navigateEditorFind = (activeFilePath: string, direction: 'next' | 'previous') => {
      if (!SearchReplaceStateManager.navigate(activeFilePath, direction)) {
        dispatchEditorKeyEvent('g', 'KeyG', true, direction === 'previous');
      }
    };

    const handleFindNext = () => {
      const activeFilePath = editorTabsRef.current?.getActiveFilePath();
      if (showEditorTabs && lastFocusedPanelRef.current === 'editor' && activeFilePath) {
        navigateEditorFind(activeFilePath, 'next');
      } else if (activeSessionId) {
        window.dispatchEvent(new CustomEvent('transcript:find-next', {
          detail: { sessionId: activeSessionId }
        }));
      }
    };

    const handleFindPrevious = () => {
      const activeFilePath = editorTabsRef.current?.getActiveFilePath();
      if (showEditorTabs && lastFocusedPanelRef.current === 'editor' && activeFilePath) {
        navigateEditorFind(activeFilePath, 'previous');
      }
    };

    window.addEventListener('menu:find', handleFind);
    window.addEventListener('menu:find-next', handleFindNext);
    window.addEventListener('menu:find-previous', handleFindPrevious);

    return () => {
      window.removeEventListener('menu:find', handleFind);
      window.removeEventListener('menu:find-next', handleFindNext);
      window.removeEventListener('menu:find-previous', handleFindPrevious);
    };
  }, [isActive, activeSessionId, showEditorTabs, triggerEditorFind, dispatchEditorKeyEvent]);

  // Expose ref methods
  useImperativeHandle(ref, () => ({
    closeActiveTab: () => {
      // Only close editor tabs if the editor panel was last focused
      if (showEditorTabs && lastFocusedPanelRef.current === 'editor' && editorTabsRef.current) {
        editorTabsRef.current.closeActiveTab();
      }
      // If transcript has focus, do nothing - we don't want to close AI sessions with CMD+W
    },
    // Menu/shortcut path for the same action as double-clicking a tab. With no
    // editor tab open, maximizing would force layoutMode 'editor' only for the
    // auto-collapse effect to bounce it back to the transcript, so only the
    // restore direction stays live.
    toggleEditorMaximized: () => {
      if (isEditorMaximized || hasTabs) toggleEditorMaximized();
    },
  }), [isEditorMaximized, hasTabs, showEditorTabs, toggleEditorMaximized]);

  return (
    <>
      <AgentWorkstreamLayout
        panelRef={panelRef} editorRef={editorAreaRef} sessionRef={sessionAreaRef} rightPanelRef={rightPanelRef}
        placement={filePlacement} layoutMode={layoutMode} editorVisible={showEditorTabs}
        sidebarVisible={sidebarVisible} viewerSelected={viewerSelected} sidebarWidth={sidebarWidth}
        splitRatio={splitRatio} draggingVertical={isDraggingVertical} draggingSidebar={isDraggingSidebar}
        onVerticalResize={handleVerticalResizeStart} onSidebarResize={handleSidebarResizeStart}
        header={
          <WorkstreamHeader
            workstreamId={workstreamId}
            activeSessionId={chatTargetId}
            worktreeId={sessionWorktreeId}
            worktreePath={worktreePath}
            onOpenTerminal={sessionWorktreeId ? handleOpenTerminal : undefined}
            onCreateNewTerminal={sessionWorktreeId ? handleCreateNewTerminal : undefined}
            onShowArchiveDialog={sessionWorktreeId ? handleShowArchiveDialog : undefined}
            onArchiveStatusChange={onWorktreeArchived}
            onOpenSession={onSwitchToAgentMode && (sessionId => onSwitchToAgentMode(undefined, sessionId))}
          />
        }
        editor={worktreePathReady ? (
          <WorkstreamEditorTabs
            key={workstreamId}
            ref={editorTabsRef}
            workstreamId={workstreamId}
            workspacePath={workspacePath}
            basePath={worktreePath || workspacePath}
            isActive={isActive && showEditorTabs}
            onSwitchToAgentMode={onSwitchToAgentMode}
            onOpenSessionInChat={onOpenSessionInChat}
            onTabDoubleClick={toggleEditorMaximized}
            onBeforeMove={isEditorMaximized ? toggleEditorMaximized : undefined}
          />
        ) : null}
        transcript={
          <WorkstreamSessionTabs
            workspacePath={workspacePath}
            workstreamId={workstreamId}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSessionSelect={handleSessionSelect}
            onFileClick={handleFileClick}
            worktreeId={sessionWorktreeId}
            onAddSessionToWorktree={onAddSessionToWorktree}
            onCreateWorktreeSession={onCreateWorktreeSession}
            onSessionArchive={handleSessionArchive}
            onSessionUnarchive={handleSessionUnarchive}
            onSessionRename={handleSessionRename}
            documentContext={sessionDocumentContext}
            getDocumentContext={getDocumentContext}
            collapseTranscript={collapseTranscript}
          />
        }
        sidebar={sidebarVisible ? <>
          {rightPanelMode === 'edited-files' && (
            <FilesEditedSidebar
              workstreamId={workstreamId}
              activeSessionId={activeSessionId}
              workspacePath={workspacePath}
              onFileClick={handleFileClick}
              onOpenInFilesMode={onFileOpen}
              width="100%"
              worktreeId={sessionWorktreeId}
              worktreePath={worktreePath}
              onWorktreeArchived={onWorktreeArchived}
              isGitRepo={isGitRepo}
            />
          )}
          {rightPanelMode === 'review' && (
            <AgentReviewPanel
              workstreamId={workstreamId}
              activeSessionId={activeSessionId}
              workspacePath={workspacePath}
              width="100%"
              worktreeId={sessionWorktreeId}
              worktreePath={worktreePath}
            />
          )}
          {rightPanelMode === 'session-chat' && (
            chatTargetId && chatSessionId ? (
              <ChatSidebar
                workspacePath={workspacePath}
                isActive={isActive}
                sessionId={chatSessionId}
                onSessionIdChange={handleChatSessionChange}
                autoInitializeSession={false}
                newSessionTitle={`Chat with ${chatTargetTitle}`.slice(0, 120)}
                newSessionDraft={sessionMentionDraft(chatTargetId, chatTargetTitle)}
                linkedSession={{ id: chatTargetId, title: chatTargetTitle }}
                onFileOpen={handleFileClick}
              />
            ) : (
              <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center text-sm text-nim-muted">
                {chatCreationError ? (
                  <>
                    <MaterialSymbol icon="error" size={28} className="text-nim-error" />
                    <span>{chatCreationError}</span>
                    <button
                      type="button"
                      onClick={() => setChatCreationAttempt((attempt) => attempt + 1)}
                      className="px-3 py-1.5 rounded border border-nim bg-nim-secondary text-xs text-nim cursor-pointer hover:bg-nim-hover"
                    >
                      Try again
                    </button>
                  </>
                ) : (
                  <>
                    <span className="w-5 h-5 border-2 border-nim border-t-nim-primary rounded-full animate-spin" />
                    <span>{chatTargetId ? 'Opening chat…' : 'Select a session to start chatting.'}</span>
                  </>
                )}
              </div>
            )
          )}
        </> : null}
      />
      {/* Archive worktree confirmation dialog */}
      {archiveDialogState && (
        <ArchiveWorktreeDialog
          worktreeName={archiveDialogState.worktreeName}
          onArchive={handleConfirmArchive}
          onKeep={closeArchiveDialog}
          hasUncommittedChanges={archiveDialogState.hasUncommittedChanges}
          uncommittedFileCount={archiveDialogState.uncommittedFileCount}
          hasUnmergedChanges={archiveDialogState.hasUnmergedChanges}
          unmergedCommitCount={archiveDialogState.unmergedCommitCount}
        />
      )}
    </>
  );
}));

AgentWorkstreamPanel.displayName = 'AgentWorkstreamPanel';
