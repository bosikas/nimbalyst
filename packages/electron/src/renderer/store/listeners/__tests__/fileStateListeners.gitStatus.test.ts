// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { loadSessionFilesResult } from '../../../services/sessionFilesLoader';
import { sessionFileEditsAtom } from '../../atoms/sessionFiles';
import { loadInitialSessionFileState, unregisterSessionWorkspace } from '../fileStateListeners';

vi.mock('../../../services/sessionFilesLoader', () => ({
  loadSessionFilesResult: vi.fn(),
}));

it('requests Git status once per edited path and keeps every edit in the session history', async () => {
  const sessionId = 'repeated-file-edits';
  const workspacePath = '/workspace';
  const files = Array.from({ length: 1000 }, (_, index) => ({
    id: String(index),
    sessionId,
    workspaceId: workspacePath,
    filePath: ['src/a.ts', 'src/b.ts', '/attached/c.ts'][index % 3],
    linkType: 'edited' as const,
    timestamp: index,
    createdAt: '2026-11-21T00:00:00.000Z',
  }));
  vi.mocked(loadSessionFilesResult).mockResolvedValue({ success: true, files });
  const invoke = vi.fn(async (channel: string) =>
    channel === 'history:get-pending-files-for-session' ? [] : { success: true },
  );
  vi.stubGlobal('window', { electronAPI: { invoke } });

  try {
    await loadInitialSessionFileState(sessionId, workspacePath);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'git:get-file-status'))
      .toEqual([['git:get-file-status', workspacePath, ['src/a.ts', 'src/b.ts', '/attached/c.ts']]]);
    expect(store.get(sessionFileEditsAtom(sessionId))).toHaveLength(1000);
  } finally {
    unregisterSessionWorkspace(sessionId);
    store.set(sessionFileEditsAtom(sessionId), []);
    vi.unstubAllGlobals();
  }
});
