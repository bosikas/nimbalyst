// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { SessionNavigationToolbar } from '../SessionNavigationToolbar';
import { store } from '@nimbalyst/runtime/store';
import { settingAtom } from '../../../store/atoms/settingAtomFamily';
import { DEFAULT_SESSION_LIST_APPEARANCE } from '../../../../shared/sessionListAppearance';
vi.mock('../../RemoteMachineSelector', () => ({ RemoteMachineSelector: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
afterEach(cleanup);
function setup() {
  const props = {
    workspacePath: '/project', search: '', onSearch: vi.fn(), onNew: vi.fn(),
    sort: 'updated' as const, onSort: vi.fn(), archived: false, onArchive: vi.fn(),
    kanban: false, onKanban: vi.fn(), compact: false, onCompact: vi.fn(), context: false, onContext: vi.fn(), count: 27,
    workFilter: 'all' as const, onWorkFilter: vi.fn(), areas: ['Navigation', 'Builds'],
  };
  render(<Provider store={store}><SessionNavigationToolbar {...props} /></Provider>);
  return props;
}
it('keeps search and creation direct while secondary controls live in the dismissible menu', async () => {
  const props = setup();
  fireEvent.change(screen.getByRole('textbox', { name: 'Search sessions' }), { target: { value: 'review' } });
  expect(props.onSearch).toHaveBeenCalledWith('review');
  fireEvent.click(screen.getByRole('button', { name: 'New session' }));
  expect(props.onNew).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menuitem', { name: 'Kanban view' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Session options' }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Show archived' }));
  expect(props.onArchive).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Session options' }));
  fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Created first' }));
  expect(props.onSort).toHaveBeenCalledWith('created');
  expect(props.onNew).toHaveBeenCalledOnce();
});

it('filters by remaining work or area using a keyboard-accessible menu and can clear the filter', async () => {
  const props = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Filter sessions: All sessions' }));
  const menu = await screen.findByRole('menu');
  fireEvent.keyDown(menu, { key: 'Home' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'All sessions' }));
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemradio', { name: 'Has remaining work' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'Has remaining work' }));
  expect(props.onWorkFilter).toHaveBeenLastCalledWith('remaining');
  fireEvent.click(screen.getByRole('button', { name: 'Filter sessions: All sessions' }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'Navigation' }));
  expect(props.onWorkFilter).toHaveBeenLastCalledWith('area:Navigation');
  fireEvent.click(screen.getByRole('button', { name: 'Filter sessions: All sessions' }));
  fireEvent.click(await screen.findByRole('menuitemradio', { name: 'All sessions' }));
  expect(props.onWorkFilter).toHaveBeenLastCalledWith('all');
});
it('supports keyboard movement through options and retains access to Kanban', async () => {
  const props = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Session options' }));
  const menu = await screen.findByRole('menu');
  fireEvent.keyDown(menu, { key: 'Home' });
  expect(document.activeElement).toBe(screen.getByRole('menuitem', { name: 'Kanban view' }));
  fireEvent.keyDown(menu, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(screen.getByRole('menuitemcheckbox', { name: 'Show archived' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Kanban view' }));
  expect(props.onKanban).toHaveBeenCalledOnce();
  await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
});
it('shows the active filter and clears it without erasing the search query', () => {
  const change = vi.fn();
  render(<SessionNavigationToolbar workspacePath="/project" search="build" onSearch={vi.fn()} onNew={vi.fn()} sort="updated" onSort={vi.fn()} archived={false} onArchive={vi.fn()} kanban={false} onKanban={vi.fn()} compact={false} onCompact={vi.fn()} context={false} onContext={vi.fn()} count={3} workFilter="review" onWorkFilter={change} />);
  fireEvent.click(screen.getByRole('button', { name: 'Clear Needs review filter' }));
  expect(change).toHaveBeenCalledWith('all');
  expect((screen.getByRole('textbox', { name: 'Search sessions' }) as HTMLInputElement).value).toBe('build');
});

it('customizes typography separately from spacing, retains values on reopen, and restores defaults', async () => {
  window.electronAPI = { invoke: vi.fn() } as any;
  await store.set(settingAtom('ui.sessionListAppearance'), DEFAULT_SESSION_LIST_APPEARANCE);
  setup();
  fireEvent.click(screen.getByRole('button', { name: 'Session options' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Customize session list…' }));
  expect((screen.getByRole('spinbutton', { name: 'Summary size' }) as HTMLInputElement).value).toBe('9');
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Title size' }), { target: { value: '17' } });
  await waitFor(() => expect(store.get(settingAtom('ui.sessionListAppearance')).titleSize).toBe(17));
  expect(store.get(settingAtom('ui.sessionListAppearance')).rowPadding).toBe(6);
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  fireEvent.click(screen.getByRole('button', { name: 'Session options' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Customize session list…' }));
  expect((screen.getByRole('spinbutton', { name: 'Title size' }) as HTMLInputElement).value).toBe('17');
  fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Provider icon on children' }));
  await waitFor(() => expect(store.get(settingAtom('ui.sessionListAppearance')).showChildIcon).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: 'Reset defaults' }));
  await waitFor(() => expect(store.get(settingAtom('ui.sessionListAppearance'))).toEqual(DEFAULT_SESSION_LIST_APPEARANCE));
});

it('creates a review-style session with explicit policies without changing default creation', async () => {
  const props = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Session options' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'New session with options…' }));
  expect((screen.getByRole('checkbox', { name: 'Generate session summaries' }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole('spinbutton', { name: 'Auto-archive minutes' }) as HTMLInputElement).value).toBe('0');
  fireEvent.click(screen.getByRole('checkbox', { name: 'Generate session summaries' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Auto-archive minutes' }), { target: { value: '30' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create session' }));
  await waitFor(() => expect(props.onNew).toHaveBeenCalledWith({ generateSummary: false, autoArchiveAfterMinutes: 30 }));
});
