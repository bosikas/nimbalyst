import React, { useEffect, useMemo } from 'react';
import { atom, useAtom, useAtomValue, useStore, type Getter } from 'jotai';
import { MaterialSymbol } from '@nimbalyst/runtime/ui/icons/MaterialSymbol';
import {
  sessionRegistryAtom,
  sessionProcessingAtom,
  sessionUnreadAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionPendingPromptAtom,
  selectedWorkstreamAtom,
  type SessionMeta,
} from '../../store/atoms/sessions';
import { workspaceSessionTurnActivityAtom } from '../../store/atoms/sessionActivity';
import { workstreamStateAtom } from '../../store/atoms/workstreamState';
import { worktreeRecordAtom } from '../../store/atoms/worktrees';
import { compactRowsAtom } from '../../store/atoms/agentMode';
import { SessionListItem } from './SessionListItem';
import { settingAtom } from '../../store/atoms/settingAtomFamily';
import { buildSessionTree, isWorkstreamContainer, mergedTreeHeader, treeIndent, type SessionTreeNode } from './sessionTreeModel';

export interface SessionTreeProps {
  worktreeLabel?: string;
  onWorktreeMenu?: (event: React.MouseEvent) => void;
  revealMatches?: boolean;
  sessions: SessionMeta[];
  root?: SessionMeta;
  activeSessionId: string | null;
  projectPath?: string;
  onSessionSelect: (id: string, e: Pick<React.MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>) => void;
  onSessionDelete?: (id: string) => void;
  onSessionArchive?: (id: string) => void;
  onSessionUnarchive?: (id: string) => void;
  onSessionPinToggle?: (id: string, pinned: boolean) => void;
  onSessionRename?: (id: string, title: string) => void;
  onSessionBranch?: (id: string) => void;
  /** The sidebar's multi-selection; move and archive actions on a selected row apply to all of it. */
  selectedSessionIds?: ReadonlySet<string>;
}

export type SessionTreeRowHandlers = Omit<SessionTreeProps, 'sessions' | 'root'>;

/** One visible row of a flattened tree; virtual lists render one of these per item. */
export interface VisibleSessionTreeRow {
  node: SessionTreeNode<SessionMeta>;
  baseDepth: number;
  /** Set on a tree's top row: a merged wrapper keeps the pin identity of the hidden root. */
  pinSession?: SessionMeta;
}

/** Background activity never expands a branch; rollup indicators remain visible. */
function readTreeExpanded(get: Getter, node: { id: string; ids: readonly string[] }, activeSessionId: string | null): boolean {
  void activeSessionId;
  const state = get(workstreamStateAtom(node.id));
  return state.treeExpanded === true && (state.treeExpandedUntil === null || state.treeExpandedUntil === undefined || state.treeExpandedUntil > Date.now());
}

/**
 * Flattens each tree to its visible preorder rows. Virtualizing a whole tree as a
 * single item made one item thousands of pixels tall and change height whenever an
 * agent started or stopped, which made the scroll position jump.
 */
export function useVisibleSessionTreeRows(
  trees: readonly { key: string; rows: readonly SessionMeta[] }[],
  activeSessionId: string | null,
  projectPath: string,
  revealMatches = false,
): Map<string, VisibleSessionTreeRow[]> {
  const registry = useAtomValue(sessionRegistryAtom);
  const appearance = useAtomValue(settingAtom('ui.sessionListAppearance'));
  const store = useStore();
  const activity = useAtomValue(workspaceSessionTurnActivityAtom(projectPath));
  const forests = useMemo(
    () =>
      trees.map(({ key, rows }) => ({
        key,
        roots: buildSessionTree(
          rows.map((row) => {
            const current = registry.get(row.id) ?? row;
            return { ...current, updatedAt: Math.max(current.updatedAt, activity.get(row.id) ?? 0) };
          })
        ),
      })),
    [trees, registry, activity]
  );
  // The atom must keep its identity across renders: useAtomValue re-subscribes and
  // re-renders on every new atom, so keying on object identity loops. Key on the
  // parent nodes and their members, which is everything the atom reads.
  const parents = forests.flatMap((forest) => {
    const out: { id: string; ids: string[] }[] = [];
    const visit = (node: SessionTreeNode<SessionMeta>) => {
      if (!node.children.length) return;
      out.push({ id: node.session.id, ids: node.ids });
      node.children.forEach(visit);
    };
    forest.roots.forEach(visit);
    return out;
  });
  const parentsKey = parents.map((parent) => parent.ids.join(',')).join('|');
  const allIds = [...new Set(forests.flatMap(forest => forest.roots.flatMap(root => root.ids)))];
  const idsKey = allIds.join('\0');
  const liveKey = useAtomValue(useMemo(() => atom(get => JSON.stringify(allIds.filter(id =>
    id === activeSessionId || get(sessionProcessingAtom(id)) || get(sessionPendingPromptAtom(id)) || get(sessionHasPendingInteractivePromptAtom(id))
  ))), [idsKey, activeSessionId]));
  // A joined string keeps the subscription quiet unless the expanded set really changes.
  const expandedKey = useAtomValue(
    // eslint-disable-next-line react-hooks/exhaustive-deps -- parentsKey covers parents
    useMemo(() => atom((get) => JSON.stringify(parents.filter((parent) => get(workstreamStateAtom(parent.id)).treeExpanded === true).map((parent) => [parent.id, get(workstreamStateAtom(parent.id)).treeExpandedUntil ?? null]))), [parentsKey])
  );
  useEffect(() => {
    const leases = JSON.parse(expandedKey) as Array<[string, number | null]>;
    if (!leases.length) return;
    if (appearance.autoCollapseSeconds === 0) {
      for (const [id, until] of leases) if (until !== null) store.set(workstreamStateAtom(id), { treeExpandedUntil: null });
      return;
    }
    const now = Date.now();
    for (const [id, until] of leases) if (until === null) store.set(workstreamStateAtom(id), { treeExpandedUntil: now + appearance.autoCollapseSeconds * 1000 });
    const deadline = Math.min(...leases.map(([, until]) => until ?? now + appearance.autoCollapseSeconds * 1000));
    const timer = setTimeout(() => {
      for (const [id] of leases) {
        const state = store.get(workstreamStateAtom(id));
        if (state.treeExpandedUntil !== null && state.treeExpandedUntil <= Date.now()) store.set(workstreamStateAtom(id), { treeExpanded: false, treeExpandedUntil: null });
      }
    }, Math.max(0, deadline - now));
    return () => clearTimeout(timer);
  }, [expandedKey, store, appearance.autoCollapseSeconds]);
  return useMemo(() => {
    const expanded = new Set((JSON.parse(expandedKey) as Array<[string, number | null]>).filter(([, until]) => until === null || until > Date.now()).map(([id]) => id));
    const live = new Set(JSON.parse(liveKey) as string[]);
    const result = new Map<string, VisibleSessionTreeRow[]>();
    for (const forest of forests) {
      const rows: VisibleSessionTreeRow[] = [];
      for (const root of forest.roots) {
        const header = mergedTreeHeader(root);
        const visit = (node: SessionTreeNode<SessionMeta>, pinSession?: SessionMeta) => {
          rows.push({ node, baseDepth: header.depth, pinSession });
          const active = node.children.filter(child => child.ids.some(id => live.has(id)));
          const older = node.children.filter(child => !child.ids.some(id => live.has(id)));
          const full = revealMatches || expanded.has(node.session.id);
          const shown = full ? node.children : [...active, ...older.slice(0, appearance.olderChildren)];
          const ordered = appearance.activeChildrenFirst ? [...active.filter(child => shown.includes(child)), ...older.filter(child => shown.includes(child))] : node.children.filter(child => shown.includes(child));
          ordered.forEach(child => visit(child));
        };
        visit(header, root.session);
      }
      result.set(forest.key, rows);
    }
    return result;
  }, [forests, expandedKey, revealMatches, liveKey, appearance.activeChildrenFirst, appearance.olderChildren]);
}

/** Non-virtual tree, used inside worktree groups. */
export function SessionTree(props: SessionTreeProps) {
  const projectPath = props.projectPath || props.root?.workspaceId || props.sessions[0]?.workspaceId || '';
  const trees = useMemo(
    () => [{ key: 'tree', rows: props.root ? [props.root, ...props.sessions] : props.sessions }],
    [props.root, props.sessions]
  );
  const rows = useVisibleSessionTreeRows(trees, props.activeSessionId, projectPath, props.revealMatches).get('tree') ?? [];
  return (
    <div className="session-tree" role="tree" aria-label="Session tree">
      {rows.map((row) => (
        <SessionTreeRow key={row.node.session.id} {...props} {...row} />
      ))}
    </div>
  );
}

export function SessionTreeRow(props: SessionTreeRowHandlers & VisibleSessionTreeRow) {
  return <SessionTreeSessionRow {...props} />;
}

function SessionTreeSessionRow(props: SessionTreeRowHandlers & VisibleSessionTreeRow) {
  const { node, baseDepth, activeSessionId } = props;
  const store = useStore();
  const appearance = useAtomValue(settingAtom('ui.sessionListAppearance'));
  function extendExpansion() {
    let current: string | null = node.session.id;
    const seen = new Set<string>();
    while (current && !seen.has(current)) {
      seen.add(current);
      const state = store.get(workstreamStateAtom(current));
      if (state.treeExpanded) store.set(workstreamStateAtom(current), { treeExpandedUntil: appearance.autoCollapseSeconds ? Date.now() + appearance.autoCollapseSeconds * 1000 : null });
      current = store.get(sessionRegistryAtom).get(current)?.parentSessionId ?? null;
    }
  }
  const row = node.session;
  const worktree = useAtomValue(worktreeRecordAtom(row.worktreeId ?? ''));
  const worktreeLabel = row.worktreeId
    ? worktree ? `${worktree.displayName || worktree.name} · ${worktree.path}` : row.worktreeId
    : 'Project checkout';
  const pinSession = props.pinSession ?? row;
  const [, setState] = useAtom(workstreamStateAtom(row.id));
  const compact = useAtomValue(compactRowsAtom);
  const status = useAtomValue(
    useMemo(
      () =>
        atom((get) => {
          let running = 0;
          let review = 0;
          for (const id of node.ids) {
            if (get(sessionProcessingAtom(id))) running++;
            if (get(sessionHasPendingInteractivePromptAtom(id))) review++;
          }
          return { running, review, expanded: readTreeExpanded(get, { id: row.id, ids: node.ids }, activeSessionId) };
        }),
      // Keyed by content, not node identity, so a re-sorted list never mints a new atom.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [row.id, node.ids.join('\0'), activeSessionId]
    )
  );
  const expanded = props.revealMatches || status.expanded;
  const indent = treeIndent(node.depth - baseDepth);
  const hasChildren = node.children.length > 0;
  const hiddenCount = node.ids.length - 1;
  const isSelected = !!props.selectedSessionIds?.has(row.id);
  const selectedIds = useMemo(
    () => (isSelected && props.selectedSessionIds ? [...props.selectedSessionIds] : undefined),
    [isSelected, props.selectedSessionIds]
  );
  const isContainer = isWorkstreamContainer(row);
  // A container is never the active session; it shows as active while it is the
  // selection and none of its sessions is open (the empty-workstream state).
  const isSelectedContainer = useAtomValue(
    useMemo(
      () => atom((get) => isContainer && get(selectedWorkstreamAtom(props.projectPath || row.workspaceId || ''))?.id === row.id),
      [isContainer, props.projectPath, row.workspaceId, row.id]
    )
  );
  const isActive = row.id === activeSessionId || (isSelectedContainer && !node.ids.includes(activeSessionId ?? ''));
  // SessionListItem's memo compares these by reference; build them only when
  // their inputs change so an unrelated list render does not repaint every row.
  // Inline on the metadata line; a separate row per parent cost a line of height each.
  const details = useMemo(() => hasChildren && (
    <span className="session-tree-rollup inline-flex shrink-0 gap-1.5 whitespace-nowrap text-[10px] text-[var(--nim-text-muted)]">
      {status.running > 0 && <span className="text-[var(--nim-primary)]">{status.running} running</span>}
      {status.review > 0 && <span>{status.review} need review</span>}
      {node.uncommittedCount > 0 && (
        <span className="text-[var(--nim-warning)]">{node.uncommittedCount} uncommitted</span>
      )}
      {!expanded && <span className="session-tree-child-count" title={`${hiddenCount} child session${hiddenCount === 1 ? '' : 's'}`} aria-label={`${hiddenCount} child session${hiddenCount === 1 ? '' : 's'}`}>{hiddenCount}</span>}
    </span>
  ), [hasChildren, status.running, status.review, node.uncommittedCount, expanded, hiddenCount]);
  const leading = useMemo(() => (
    hasChildren ? (
      <button
        aria-label={`${expanded ? 'Collapse' : 'Expand'} ${row.title}`}
        aria-expanded={expanded}
        className={`session-tree-chevron shrink-0 flex items-center p-0 leading-none ${compact ? "" : "mt-1"}`}
        onClick={(e) => {
          e.stopPropagation();
          setState({ treeExpanded: !expanded, treeExpandedUntil: expanded || !appearance.autoCollapseSeconds ? null : Date.now() + appearance.autoCollapseSeconds * 1000 });
        }}
      >
        <MaterialSymbol icon={expanded ? 'expand_more' : 'chevron_right'} size={14} />
      </button>
    ) : (
      <span className="session-tree-spacer w-3.5 shrink-0" />
    )
  ), [hasChildren, expanded, row.title, compact, setState, appearance.autoCollapseSeconds]);
  return (
    <div
      className={`session-tree-row ${activeSessionId && activeSessionId !== row.id && node.ids.includes(activeSessionId) ? 'session-tree-ancestor-active' : ''}`}
      data-tree-session-id={row.id}
      onPointerEnter={extendExpansion}
      onFocusCapture={extendExpansion}
      onClickCapture={extendExpansion}
      role="treeitem"
      aria-level={node.depth - baseDepth + 1}
      aria-expanded={node.children.length ? expanded : undefined}
      style={{
        marginLeft: indent.level * appearance.indent,
        borderLeft: indent.rail && appearance.branchGuides ? '1px solid var(--nim-border)' : undefined,
      }}
    >
      <SessionListItem
        {...row}
        worktreeLabel={worktreeLabel}
        onWorktreeMenu={node.depth === baseDepth ? props.onWorktreeMenu : undefined}
        isPinned={pinSession.isPinned}
        title={row.title || 'Untitled Session'}
        isActive={isActive}
        treeContext
        projectPath={props.projectPath || row.workspaceId}
        isWorkstream={isContainer || hasChildren}
        isExpanded={hasChildren && expanded}
        isSelected={isSelected}
        selectedSessionIds={selectedIds}
        treeLeading={leading}
        treeDetails={details}
        compact={compact}
        isChild={node.depth > baseDepth}
        uncommittedCount={node.children.length ? undefined : row.uncommittedCount}
        onClick={(e) => props.onSessionSelect(row.id, e)}
        onDelete={props.onSessionDelete && (() => props.onSessionDelete!(row.id))}
        onArchive={props.onSessionArchive && (() => props.onSessionArchive!(row.id))}
        onUnarchive={props.onSessionUnarchive && (() => props.onSessionUnarchive!(row.id))}
        onPinToggle={props.onSessionPinToggle && ((pinned) => props.onSessionPinToggle!(pinSession.id, pinned))}
        onRename={props.onSessionRename && ((title) => props.onSessionRename!(row.id, title))}
        onBranch={props.onSessionBranch && !isContainer ? () => props.onSessionBranch!(row.id) : undefined}
      />
    </div>
  );
}
