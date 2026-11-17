// @vitest-environment node
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ query: vi.fn(), update: vi.fn(), windows: [] as any[], projectWindows: [] as any[], states: new Map<string, any>(), visibility: null as any, startup: null as any, events: null as any, cleanup: vi.fn() }));
vi.mock('electron', () => ({ app: { once: vi.fn() }, BrowserWindow: { getAllWindows: () => fake.windows } }));
vi.mock('../../window/windowState', () => ({ getProjectWindows: () => fake.projectWindows }));
vi.mock('../../utils/ipcRegistry', () => ({ safeOn: (_channel: string, listener: any) => { fake.visibility = listener; } }));
vi.mock('../startupMaintenanceGate', () => ({ runWhenFirstUsable: (_name: string, callback: any) => { fake.startup = callback; } }));
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
  fake.projectWindows = [...fake.windows];
  fake.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('jsonb_build_object')
    ? [{ id: 'parent', metadata: { autoArchiveAfterMinutes: 30, autoArchiveCompletedAt: Date.now() - 31 * 60_000 } }]
    : [{ id: 'parent' }, { id: 'child' }] }));
});

afterEach(() => vi.useRealTimers());

it('archives an idle worktree review even when an auxiliary window never reports a selection', async () => {
  fake.query.mockImplementation(async (sql: string) => ({ rows: sql.includes('jsonb_build_object')
    ? [{ id: 'review', worktree_id: 'review-worktree', metadata: JSON.stringify({ autoArchiveAfterMinutes: 10, autoArchiveCompletedAt: Date.now() - 11 * 60_000 }) }]
    : [{ id: 'review' }] }));
  fake.visibility({ sender: fake.projectWindows[0].webContents }, 'coordinator');
  fake.windows.push({ isDestroyed: () => false, webContents: { id: ++windowId, send: vi.fn() } });
  await sweepSessionAutoArchive();
  expect(fake.update).toHaveBeenCalledWith('review', expect.objectContaining({ isArchived: true, autoArchiveGuard: expect.objectContaining({ minutes: 10 }) }));
  expect(fake.cleanup).toHaveBeenCalledWith('review', expect.any(Function), expect.any(Function));
});

it('still protects an unreported project window when auxiliary windows are present', async () => {
  fake.visibility({ sender: fake.projectWindows[0].webContents }, null);
  const unreported = { isDestroyed: () => false, webContents: { id: ++windowId, send: vi.fn() } };
  fake.windows.push(unreported);
  fake.projectWindows.push(unreported);
  await sweepSessionAutoArchive();
  expect(fake.update).not.toHaveBeenCalled();
});

it('waits for the startup sweep and continues checking on the idle timer', async () => {
  vi.useFakeTimers();
  fake.visibility({ sender: fake.projectWindows[0].webContents }, null);
  await fake.startup();
  expect(fake.update).toHaveBeenCalledOnce();
  fake.update.mockClear();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(fake.update).toHaveBeenCalledOnce();
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
