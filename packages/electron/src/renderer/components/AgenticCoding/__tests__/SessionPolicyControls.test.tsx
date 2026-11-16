// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import { afterEach, expect, it, vi } from 'vitest';
import { sessionRegistryAtom } from '../../../store/atoms/sessions';
import { SessionPolicyEditor } from '../SessionPolicyControls';
import { SessionWorkSummaryDetails } from '../SessionWorkCaption';

afterEach(cleanup);

it('saves policy fields explicitly and prevents a disabled-summary refresh', async () => {
  const store = createStore();
  const invoke = vi.fn(async () => ({ success: true }));
  window.electronAPI = { invoke } as any;
  store.set(sessionRegistryAtom, new Map([['review', { id: 'review', generateSummary: false, autoArchiveAfterMinutes: 30 } as any]]));
  render(<Provider store={store}><SessionWorkSummaryDetails sessionId="review" workspacePath="/project" /></Provider>);
  expect((screen.getByRole('button', { name: 'Update summary' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Session settings'));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Generate session summaries' }));
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Auto-archive minutes' }), { target: { value: '0' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Saved' })).toBeTruthy());
  expect(invoke).toHaveBeenCalledWith('sessions:update-metadata', 'review', { metadata: { generateSummary: true, autoArchiveAfterMinutes: 0 } });
});

it('reports persistence failures and hides unsupported remote controls', async () => {
  const store = createStore();
  window.electronAPI = { invoke: vi.fn(async () => ({ success: false, error: 'offline' })) } as any;
  store.set(sessionRegistryAtom, new Map([['chat', { id: 'chat' } as any]]));
  const view = render(<Provider store={store}><SessionPolicyEditor sessionId="chat" /></Provider>);
  fireEvent.click(screen.getByText('Session settings'));
  fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'Could not save session settings.');
  store.set(sessionRegistryAtom, new Map([['chat', { id: 'chat', remoteHostDeviceId: 'other-host' } as any]]));
  view.rerender(<Provider store={store}><SessionPolicyEditor sessionId="chat" /></Provider>);
  expect(screen.queryByText('Session settings')).toBeNull();
});
