import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { BuiltInGuidancePanel } from '../BuiltInGuidancePanel';
import type { BuiltInGuidanceEntry, BuiltInGuidanceSettings } from '@nimbalyst/runtime/ai/builtInGuidance';

afterEach(cleanup);
function setup() {
  let entries: BuiltInGuidanceEntry[] = [
    { id: 'git-commits', title: 'Commit proposals', description: 'Commit guidance', enabled: true, previews: [{ provider: 'Codex', text: 'Use developer_git_commit_proposal.' }] },
    { id: 'session-metadata', title: 'Session metadata', description: 'Naming guidance', enabled: true, previews: [{ provider: 'Codex', text: 'Maintain the session title.' }] },
  ];
  const update = vi.fn(async (settings: BuiltInGuidanceSettings) => {
    entries = entries.map((entry) => ({ ...entry, enabled: settings[entry.id] ?? entry.enabled }));
    return entries;
  });
  const updateText = vi.fn(async (id: string, text: string | null) => {
    entries = entries.map(entry => entry.id === id ? { ...entry, customText: text ?? undefined } : entry);
    return entries;
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agentGuidance: { getCatalog: vi.fn(async () => entries), update, updateText } } });
  return { update, updateText };
}

it('saves a control and reads its persisted value after reopening, with instructions available for review', async () => {
  const { update } = setup();
  let view = render(<BuiltInGuidancePanel />);
  const toggle = await view.findByRole('checkbox', { name: 'Commit proposals' });
  expect((toggle as HTMLInputElement).checked).toBe(true);
  expect(view.getByText('Use developer_git_commit_proposal.').textContent).toContain('developer_git_commit_proposal');
  fireEvent.click(toggle);
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  expect(update).toHaveBeenCalledWith({ 'git-commits': false });
  view.unmount();
  view = render(<BuiltInGuidancePanel />);
  expect((await view.findByRole('checkbox', { name: 'Commit proposals' }) as HTMLInputElement).checked).toBe(false);
});

it('edits and resets a section while preserving unsaved text after a failed save', async () => {
  const { updateText } = setup();
  const view = render(<BuiltInGuidancePanel />);
  fireEvent.click(await view.findByRole('button', { name: 'Edit Commit proposals' }));
  const editor = view.getByRole('textbox', { name: 'Instructions for Commit proposals' }) as HTMLTextAreaElement;
  expect(editor.value).toBe('Use developer_git_commit_proposal.');
  fireEvent.change(editor, { target: { value: 'Use my review process.' } });
  updateText.mockRejectedValueOnce(new Error('Disk full'));
  fireEvent.click(view.getByRole('button', { name: 'Save instructions' }));
  expect((await view.findByRole('alert')).textContent).toContain('Disk full');
  expect(editor.value).toBe('Use my review process.');
  fireEvent.click(view.getByRole('button', { name: 'Save instructions' }));
  await waitFor(() => expect(view.queryByRole('textbox', { name: 'Instructions for Commit proposals' })).toBeNull());
  expect(updateText).toHaveBeenLastCalledWith('git-commits', 'Use my review process.');
  expect(view.getByText('Use my review process.').textContent).toBe('Use my review process.');
  fireEvent.click(view.getByRole('button', { name: 'Reset Commit proposals to default' }));
  await waitFor(() => expect(updateText).toHaveBeenLastCalledWith('git-commits', null));
  await waitFor(() => expect(view.queryByText('Use my review process.')).toBeNull());
});

it('disables all entries even when search hides some, and retains saved state on failure', async () => {
  const { update } = setup();
  const view = render(<BuiltInGuidancePanel />);
  await view.findByRole('checkbox', { name: 'Commit proposals' });
  fireEvent.change(view.getByRole('textbox'), { target: { value: 'Commit' } });
  fireEvent.click(view.getByRole('button', { name: 'Disable all' }));
  await waitFor(() => expect(update).toHaveBeenCalledWith({ 'git-commits': false, 'session-metadata': false }));
  await waitFor(() => expect((view.getByRole('checkbox') as HTMLInputElement).disabled).toBe(false));
  update.mockRejectedValueOnce(new Error('Disk full'));
  fireEvent.click(view.getByRole('checkbox'));
  expect((await view.findByRole('alert')).textContent).toContain('Disk full');
  expect((view.getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});
