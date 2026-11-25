import { atom } from 'jotai';
import type { FileLink } from '@nimbalyst/runtime/ai/server/types';
import { atomFamily } from '../debug/atomFamilyRegistry';
import { getRelativeWorkspacePath, normalizePath, resolveProjectPath } from '../../../shared/pathUtils';

/** Share invalidation across main-checkout and worktree views of the same file. */
export function fileSessionLinkKey(workspacePath: string, filePath: string): string {
  const relative = getRelativeWorkspacePath(filePath, workspacePath);
  return relative === null ? normalizePath(filePath) : `${normalizePath(resolveProjectPath(workspacePath))}/${relative}`;
}

export const fileSessionLinksRevisionAtom = atomFamily((_fileKey: string) => atom(0));

/** Keep summaries only for files with revision atoms. Unopened files fetch fresh on mount. */
export function createFileSessionLinksInvalidator(
  invalidate: (key: string) => void,
  listTrackedKeys: () => Iterable<string>,
) {
  const previous = new Map<string, Map<string, string>>();
  return (sessionId: string, files: FileLink[]) => {
    const trackedKeys = new Set(listTrackedKeys());
    if (!trackedKeys.size) {
      previous.delete(sessionId);
      return;
    }

    const summaries = new Map<string, { count: number; timestamp: number; source: unknown }>();
    for (const file of files) {
      const path = /^(?:\/|[A-Za-z]:[\\/])/.test(file.filePath)
        ? file.filePath : `${file.workspaceId}/${file.filePath}`;
      const key = fileSessionLinkKey(file.workspaceId, path);
      if (!trackedKeys.has(key)) continue;
      const entry = summaries.get(key) ?? { count: 0, timestamp: -Infinity, source: undefined };
      entry.count++;
      if (file.timestamp >= entry.timestamp) {
        entry.timestamp = file.timestamp;
        entry.source = file.metadata && 'source' in file.metadata ? file.metadata.source : undefined;
      }
      summaries.set(key, entry);
    }
    const next = new Map<string, string>();
    for (const [key, summary] of summaries) next.set(key, JSON.stringify(summary));

    const before = previous.get(sessionId);
    if (next.size) previous.set(sessionId, next);
    else previous.delete(sessionId);

    if (before) {
      for (const [key, summary] of before) {
        if (trackedKeys.has(key) && summary !== next.get(key)) invalidate(key);
      }
    }
    for (const key of next.keys()) {
      if (!before?.has(key)) invalidate(key);
    }
  };
}
