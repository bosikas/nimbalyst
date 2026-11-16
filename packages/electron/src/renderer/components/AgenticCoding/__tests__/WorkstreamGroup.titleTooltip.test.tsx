// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/ProviderIcons', () => ({ ProviderIcon: () => null, resolveProviderIcon: (provider: string) => provider }));
vi.mock('@nimbalyst/runtime/utils/clipboard', () => ({ copyToClipboard: () => {} }));
vi.mock('../../../services/ErrorNotificationService', () => ({
  errorNotificationService: { showInfo: () => {}, showError: () => {} },
}));
vi.mock('../../../dialogs', () => ({
  dialogRef: { current: null },
  DIALOG_IDS: { SHARE: 'share' },
}));
vi.mock('../SessionContextMenu', () => ({ SessionContextMenu: () => null }));
vi.mock('../SessionRelativeTime', () => ({ SessionRelativeTime: () => null }));

import { WorkstreamGroup } from '../WorkstreamGroup';
import { Provider } from 'jotai';
import { store } from '@nimbalyst/runtime/store';
import { sessionRegistryAtom } from '../../../store/atoms/sessions';
import { settingAtom } from '../../../store/atoms/settingAtomFamily';
import { DEFAULT_SESSION_LIST_APPEARANCE } from '../../../../shared/sessionListAppearance';

const groupTitle = 'A workstream name that is long enough to be clipped by the session pane';
const childTitle = 'A child session name that is long enough to be clipped by the session pane';

const setElementWidth = (element: Element, { clientWidth, scrollWidth }: { clientWidth: number; scrollWidth: number }) => {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
};

afterEach(() => cleanup());

describe('WorkstreamGroup - full name on hover', () => {
  it('removes a redundant single-root worktree heading, while keeping multiple roots grouped', () => {
    const root = { id: 'coordinator', title: 'PR review coordinator', provider: 'openai-codex', parentSessionId: null, createdAt: Date.now(), updatedAt: Date.now() } as any;
    const child = { ...root, id: 'review', title: 'Review child', parentSessionId: root.id };
    store.set(settingAtom('ui.sessionListAppearance'), DEFAULT_SESSION_LIST_APPEARANCE);
    store.set(sessionRegistryAtom, new Map([[root.id, root], [child.id, child]]));
    const props = { type: 'worktree' as const, id: 'single-root', title: 'nightly-river 00', isExpanded: false, isActive: false, activeSessionId: null, onSessionSelect: vi.fn(), onToggle: vi.fn(), onSelect: vi.fn() };
    const view = render(<Provider store={store}><WorkstreamGroup {...props} sessions={[root, child]} /></Provider>);
    expect(screen.queryByRole('button', { name: /Worktree: nightly-river/ })).toBeNull();
    expect(screen.getByText(root.title)).toBeTruthy();
    const other = { ...root, id: 'other-root', title: 'Another coordinator' };
    store.set(sessionRegistryAtom, new Map([[root.id, root], [child.id, child], [other.id, other]]));
    view.rerender(<Provider store={store}><WorkstreamGroup {...props} sessions={[root, child, other]} /></Provider>);
    expect(screen.getByRole('button', { name: /Worktree: nightly-river/ })).toBeTruthy();
  });
  it('keeps group navigation separate from expansion for mouse and keyboard users', () => {
    const select = vi.fn(), toggle = vi.fn();
    render(<WorkstreamGroup type="worktree" id="wt" title="Storybook router review" isExpanded={false} isActive={false}
      sessions={[]} activeSessionId={null} onSessionSelect={vi.fn()} onSelect={select} onToggle={toggle} />);
    fireEvent.click(screen.getByRole('button', { name: 'Expand worktree' }));
    expect(toggle).toHaveBeenCalledOnce();
    expect(select).not.toHaveBeenCalled();
    const title = screen.getByRole('button', { name: 'Worktree: Storybook router review, 0 sessions' });
    fireEvent.click(title);
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(select).toHaveBeenCalledTimes(2);
    expect(toggle).toHaveBeenCalledOnce();
  });
  it('shows the merged session header name only when clipped', () => {
    const { container } = render(
      <WorkstreamGroup
        type="workstream"
        id="workstream-1"
        title={groupTitle}
        isExpanded
        isActive={false}
        onToggle={() => {}}
        onSelect={() => {}}
        sessions={[{ id: 'session-1', parentSessionId: 'workstream-1', title: childTitle, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 } as any]}
        activeSessionId={null}
        onSessionSelect={() => {}}
      />,
    );

    const childName = container.querySelector('.session-list-item-title')!;
    setElementWidth(childName, { clientWidth: 160, scrollWidth: 300 });
    fireEvent.mouseEnter(childName);
    expect(screen.getByRole('tooltip').textContent).toBe(childTitle);

    fireEvent.mouseLeave(childName);
    setElementWidth(childName, { clientWidth: 320, scrollWidth: 300 });
    fireEvent.mouseEnter(childName);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
});
