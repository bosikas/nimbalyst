// @vitest-environment node
import { beforeAll, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ handlers: new Map<string, Function>(), subtree: vi.fn() }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp', on: vi.fn(), getName: () => 'x', getVersion: () => '1' }, ipcMain: { handle: vi.fn(), on: vi.fn() }, BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../../utils/ipcRegistry', () => ({ safeHandle: (k: string, f: Function) => h.handlers.set(k, f), safeOn: vi.fn(), removeHandler: vi.fn() }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { list: async () => [], get: async () => null } }));
vi.mock('../../services/sessionHierarchy', async importOriginal => ({ ...(await importOriginal<object>()), readSessionSubtree: h.subtree }));
vi.mock('../../utils/gitUncommittedFiles', async importOriginal => ({ ...(await importOriginal<object>()), getCachedUncommittedFiles: async () => new Set<string>() }));

// SessionHandlers pulls in most of main; import and register once for the file.
beforeAll(async () => {
  const { registerSessionHandlers } = await import('../SessionHandlers');
  await registerSessionHandlers();
}, 60_000);

// The renderer overwrites a child's registry entry with this list, so a field
// missing here blanks "Coordinated by" and "Coordinates" for nested workers.
it('keeps each child\'s coordinator in the child list', async () => {
  const row = (id: string, metadata: object) => ({
    id, parent_session_id: 'root', workspace_id: '/p', depth: 1, created_at: 1, updated_at: 1, metadata,
  });
  h.subtree.mockResolvedValue([
    { ...row('root', {}), parent_session_id: null, depth: 0 },
    row('worker', { coordinatorSessionId: 'root' }),
    row('plain', {}),
  ]);
  const result = await h.handlers.get('sessions:list-children')!({}, 'root', '/p');
  expect(result).toMatchObject({ success: true });
  expect(result.children.map((c: any) => [c.id, c.coordinatorSessionId])).toEqual([['worker', 'root'], ['plain', null]]);
});
