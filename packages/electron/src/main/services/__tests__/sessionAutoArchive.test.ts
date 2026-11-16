// @vitest-environment node
import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ query: vi.fn(), update: vi.fn(), windows: [] as any[], states: new Map<string, any>(), visibility: null as any, events: null as any, cleanup: vi.fn() }));
vi.mock('electron', () => ({ app: { once: vi.fn() }, BrowserWindow: { getAllWindows: () => fake.windows } }));
vi.mock('../../utils/ipcRegistry', () => ({ safeOn: (_channel: string, listener: any) => { fake.visibility = listener; } }));
vi.mock('../startupMaintenanceGate', () => ({ runWhenFirstUsable: vi.fn() }));
vi.mock('../../database/initialize', () => ({ getDatabase: () => ({ query: fake.query }) }));
vi.mock('@nimbalyst/runtime/storage/repositories/AISessionsRepository', () => ({ AISessionsRepository: { get: vi.fn(), updateMetadata: fake.update } }));
vi.mock('@nimbalyst/runtime/ai/server/SessionStateManager', () => ({ getSessionStateManager: () => ({ on: (...args: any[]) => fake.events.on(...args), getSessionState: (id: string) => fake.states.get(id) }) }));
vi.mock('@nimbalyst/runtime/ai/server/ProviderFactory', () => ({ ProviderFactory: { destroyProvider: vi.fn() } }));
vi.mock('../ai/archiveSessionProviderLifecycle', () => ({ destroyProviderForArchivedSession: fake.cleanup }));
import { autoArchiveDue, configureSessionAutoArchive, sweepSessionAutoArchive } from '../sessionAutoArchive';

let windowId = 0;
beforeEach(() => {
  fake.events ??= new EventEmitter();
  configureSessionAutoArchive();
  fake.query.mockReset(); fake.update.mockReset(); fake.cleanup.mockReset(); fake.states.clear();
  fake.windows = [{ isDestroyed: () => false, webContents: { id: ++windowId, send: vi.fn() } }];
  fake.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('jsonb_build_object')
    ? [{ id: 'parent', metadata: { autoArchiveAfterMinutes: 30, autoArchiveCompletedAt: Date.now() - 31 * 60_000 } }]
    : [{ id: 'parent' }, { id: 'child' }] }));
});

it('defaults to disabled and requires a completed turn and elapsed timer, including after restart', () => {
  const now = Date.now();
  expect(autoArchiveDue({}, now)).toBeNull();
  expect(autoArchiveDue({ autoArchiveAfterMinutes: 0, autoArchiveCompletedAt: now - 60_000 }, now)).toBeNull();
  expect(autoArchiveDue({ autoArchiveAfterMinutes: 30 }, now)).toBeNull();
  expect(autoArchiveDue({ autoArchiveAfterMinutes: 30, autoArchiveCompletedAt: now }, now)).toBeNull();
  expect(autoArchiveDue(JSON.stringify({ autoArchiveAfterMinutes: 30, autoArchiveCompletedAt: now - 31 * 60_000 }), now)).toMatchObject({ minutes: 30 });
});

it('defers unknown selections, selected descendants and live work; archives without deleting evidence when safe', async () => {
  await sweepSessionAutoArchive();
  expect(fake.update).not.toHaveBeenCalled();
  const sender = fake.windows[0].webContents;
  fake.visibility({ sender }, 'child');
  await sweepSessionAutoArchive();
  expect(fake.update).not.toHaveBeenCalled();
  fake.visibility({ sender }, 'other-chat');
  fake.states.set('child', { status: 'running' });
  await sweepSessionAutoArchive();
  expect(fake.update).not.toHaveBeenCalled();
  fake.states.set('child', { status: 'idle', isStreaming: true });
  await sweepSessionAutoArchive();
  expect(fake.update).not.toHaveBeenCalled();
  fake.states.clear();
  await sweepSessionAutoArchive();
  expect(fake.update).toHaveBeenCalledWith('parent', expect.objectContaining({ isArchived: true, autoArchiveGuard: expect.objectContaining({ minutes: 30 }) }));
  expect(fake.cleanup.mock.calls.map(call => call[0])).toEqual(['parent', 'child']);
});

it('does not destroy providers if the durable archive guard detects a state change', async () => {
  fake.visibility({ sender: fake.windows[0].webContents }, null);
  fake.update.mockRejectedValue(new Error('archive guard failed'));
  await sweepSessionAutoArchive();
  expect(fake.update).toHaveBeenCalledOnce();
  expect(fake.cleanup).not.toHaveBeenCalled();
});
