// @vitest-environment node
import { expect, it } from 'vitest';
import { sessionListMetadata } from '../sessionListMetadata';

it('retains external source and activity without changing provider or workspace ownership', () => {
  expect(sessionListMetadata({ id: 'external', createdAt: 1, updatedAt: 2, provider: 'openai-codex', externalSource: 'openai-codex', externalLastActivityAt: 3 }, '/parent')).toMatchObject({
    id: 'external', provider: 'openai-codex', workspaceId: '/parent', externalSource: 'openai-codex', externalLastActivityAt: 3,
  });
  expect(sessionListMetadata({ id: 'local', createdAt: 1, updatedAt: 2 }, '/parent').externalSource).toBeUndefined();
});

vi.mock('../../index', async () => {
  const { createStore } = await import('jotai'); return { store: createStore() };
});
vi.mock('../sessions', async () => {
  const { atom } = await import('jotai');
  return { activeSessionIdAtom: atom<string | null>(null), sessionRegistryAtom: atom(new Map()), sessionListWorkspaceAtom: atom('/parent'), refreshSessionListAtom: atom(null, () => {}), sessionChildrenAtom: () => atom([]), sessionParentIdAtom: () => atom(null) };
});
vi.mock('../workstreamState', async () => {
  const { atom } = await import('jotai'); return { workstreamStateAtom: () => atom({}) };
});
import { vi } from 'vitest';
import { store } from '../../index';
import { sessionRegistryAtom, activeSessionIdAtom } from '../sessions';
import { initSessionListListeners } from '../../listeners/sessionListListeners';
it('reports selected-session changes for archive protection and unsubscribes on disposal', () => {
  const send = vi.fn();
  vi.stubGlobal('window', { electronAPI: { send, on: () => () => {} } });
  store.set(activeSessionIdAtom, null);
  const dispose = initSessionListListeners();
  expect(send).toHaveBeenLastCalledWith('sessions:visible-session', null);
  store.set(activeSessionIdAtom, 'selected-child');
  expect(send).toHaveBeenLastCalledWith('sessions:visible-session', 'selected-child');
  dispose();
  send.mockClear();
  store.set(activeSessionIdAtom, null);
  expect(send).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
it('routes targeted external metadata updates into the registry without changing sibling entries', () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  vi.stubGlobal('window', { electronAPI: { on: (channel: string, handler: any) => { handlers.set(channel, handler); return () => {}; } } });
  const own = sessionListMetadata({ id: 'own', createdAt: 1, updatedAt: 2 }, '/parent');
  const sibling = sessionListMetadata({ id: 'sibling', createdAt: 1, updatedAt: 2 }, '/parent');
  store.set(sessionRegistryAtom, new Map([['own', own], ['sibling', sibling]]));
  const dispose = initSessionListListeners();
  try {
    const workSummary = { scope: 'Session navigation and context visibility', remaining: 'Review sidebar', attention: 'review', areas: ['Navigation'], state: 'ready', coverage: 'complete', updatedAt: 100, throughMessageId: 12 };
    handlers.get('sessions:session-updated')!('own', { externalSource: 'claude-code', externalLastActivityAt: 42, workSummary });
    expect(store.get(sessionRegistryAtom).get('own')).toMatchObject({ externalSource: 'claude-code', externalLastActivityAt: 42 });
    expect(store.get(sessionRegistryAtom).get('sibling')).toBe(sibling);
    expect(store.get(sessionRegistryAtom).get('own')?.workSummary).toEqual(workSummary);
  } finally { dispose(); vi.unstubAllGlobals(); }
});

import { sessionBackgroundTasksAtom, describeBackgroundWait } from '../sessionBackgroundTasks';
it('keeps background-wait updates out of the registry and clears them on an empty list', () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  vi.stubGlobal('window', { electronAPI: { on: (channel: string, handler: any) => { handlers.set(channel, handler); return () => {}; } } });
  const registry = new Map([['own', sessionListMetadata({ id: 'own', createdAt: 1, updatedAt: 2 }, '/parent')]]);
  store.set(sessionRegistryAtom, registry);
  const dispose = initSessionListListeners();
  try {
    const tasks = [{ taskId: 't1', description: 'Run the gates', taskType: 'local_bash', startedAt: 0 }];
    handlers.get('sessions:session-updated')!('own', { backgroundTasks: tasks });
    expect(store.get(sessionBackgroundTasksAtom('own'))).toEqual(tasks);
    // No registry rewrite, so list subscribers do not re-render on every task change.
    expect(store.get(sessionRegistryAtom)).toBe(registry);
    expect(describeBackgroundWait(tasks, 12 * 60_000)).toBe('Waiting on background task: Run the gates (12m)');
    handlers.get('sessions:session-updated')!('own', { backgroundTasks: [] });
    expect(store.get(sessionBackgroundTasksAtom('own'))).toEqual([]);
  } finally { dispose(); vi.unstubAllGlobals(); }
});
