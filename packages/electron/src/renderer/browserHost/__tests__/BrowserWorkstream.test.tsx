import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import BrowserWorkstream from '../BrowserWorkstream';

vi.mock('../../components/AgentMode/WorkstreamHeader', () => ({
  WorkstreamHeader: () => null,
}));
vi.mock('../../components/AgentMode/WorkstreamSessionTabs', () => ({
  SessionTabBar: ({ sessions, onSessionSelect, onNewSession, creatingSession }: {
    sessions: string[];
    onSessionSelect: (id: string) => void;
    onNewSession: () => void;
    creatingSession: boolean;
  }) => <>
    {sessions.map((id) => <button key={id} onClick={() => onSessionSelect(id)}>{id}</button>)}
    <button onClick={onNewSession} disabled={creatingSession}>New tab</button>
  </>,
}));
vi.mock('../../store/atoms/sessions', async () => {
  const { atom } = await import('jotai');
  const registry = new Map([['parent', { sessionType: 'workstream' }]]);
  const tabs = atom(['first', 'second']);
  return {
    activeSessionIdAtom: atom<string | null>(null),
    sessionRegistryAtom: atom(registry),
    workstreamSessionsAtom: () => tabs,
    updateSessionStoreAtom: atom(null, () => {}),
  };
});

it('opens a workstream container on its first transcript and creates a child under that workstream', async () => {
  const onSelect = vi.fn();
  const onCommand = vi.fn().mockResolvedValue({ sessionId: 'new-child' });
  render(<BrowserWorkstream workstreamId="parent" selected="parent"
    onSelect={onSelect} onCommand={onCommand} renderSession={(id) => <p>Transcript {id}</p>} />);

  expect(screen.getByText('Transcript first').textContent).toBe('Transcript first');
  fireEvent.click(screen.getByRole('button', { name: 'second' }));
  expect(onSelect).toHaveBeenCalledWith('second');

  fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
  expect(onCommand).toHaveBeenCalledWith('sessions:create-child', 'parent');
  await waitFor(() => expect(onSelect).toHaveBeenLastCalledWith('new-child'));
});
