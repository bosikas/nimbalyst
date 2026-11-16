import { atom, type Getter } from 'jotai';
import {
  sessionChildrenAtom,
  sessionHasPendingInteractivePromptAtom,
  sessionPendingPromptAtom,
  sessionProcessingAtom,
  sessionRegistryAtom,
} from '../../store/atoms/sessions';

export type TodayActivity = 'Running' | 'Needs you' | 'Idle';

const childIndexAtom = atom(get => {
  const children = new Map<string, string[]>();
  for (const session of get(sessionRegistryAtom).values()) {
    if (!session.parentSessionId || session.isArchived) continue;
    const siblings = children.get(session.parentSessionId) ?? [];
    siblings.push(session.id);
    children.set(session.parentSessionId, siblings);
  }
  return children;
});

function members(get: Getter, roots: readonly string[]): string[] {
  const registry = get(sessionRegistryAtom);
  const children = get(childIndexAtom);
  const pending = [...roots];
  const visited = new Set<string>();
  const ids: string[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    if (registry.get(id)?.isArchived) continue;
    ids.push(id);
    pending.push(...(children.get(id) ?? []), ...get(sessionChildrenAtom(id)));
  }
  return ids;
}

export function createWorkAttentionCountAtom(roots: readonly string[], descendantsOnly = false) {
  return atom(get => {
    return members(get, roots).filter(id => {
      if (descendantsOnly && roots.includes(id)) return false;
      return get(sessionHasPendingInteractivePromptAtom(id));
    }).length;
  });
}

/** Partition whole list items, never individual descendants, using live state.
 * A blocked turn is waiting even if its transport still reports processing.
 * Another running descendant takes priority over that blocked turn.
 */
export function createTodayActivityGroupsAtom<T>(items: readonly T[], sessionIds: (item: T) => readonly string[]) {
  return atom((get): Record<TodayActivity, T[]> => {
    const groups: Record<TodayActivity, T[]> = { Running: [], 'Needs you': [], Idle: [] };
    if (!items.length) return groups;

    for (const item of items) {
      let running = false;
      let waiting = false;
      for (const id of members(get, sessionIds(item))) {
        const blocked = get(sessionHasPendingInteractivePromptAtom(id));
        waiting ||= blocked;
        // A queued prompt is work awaiting dispatch, not a request for human input.
        const processing = get(sessionProcessingAtom(id));
        const queued = get(sessionPendingPromptAtom(id));
        running ||= !blocked && (processing || queued);
      }
      groups[running ? 'Running' : waiting ? 'Needs you' : 'Idle'].push(item);
    }
    return groups;
  });
}
