import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { Provider, createStore } from 'jotai';
import type { AgentGuidancePreview } from '@nimbalyst/runtime/ai/builtInGuidance';

vi.mock('../../../store/atoms/sessions', async () => {
  const { atom } = await import('jotai');
  const captured = atom({ systemPromptAddition: 'Previously captured instructions.', userMessageAddition: 'Selected document context.', timestamp: 1, messageIndex: 0 });
  return { activeSessionIdAtom: atom('session-1'), sessionPromptAdditionsAtom: () => captured };
});
vi.mock('../panels/ProjectPermissionsPanel', () => ({ ProjectPermissionsPanel: () => null }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));

import { AgentSetupPanel } from '../AgentSetupPanel';

afterEach(cleanup);

function setup(preview = vi.fn(async (_workspace: string, provider: string): Promise<AgentGuidancePreview> => ({ provider: provider as AgentGuidancePreview['provider'], role: 'Developer instructions', scope: 'Baseline only.', text: `${provider} saved guidance.` }))) {
  const invoke = vi.fn(async (channel: string) => channel === 'mcp-config:get-tool-budget' ? {
    eagerEstTokens: 0,
    groups: [{ configKey: 'nimbalyst-trackers', displayName: 'Trackers', source: 'first-party', loadPolicy: 'deferred', toolCount: 1, estTokens: 10, schemaBytes: 40, enabled: true, lockedOn: false, inclusionReason: 'Workspace tools', tools: [{ name: 'tracker_read', description: 'Read an item.', inputSchema: { type: 'object', properties: { key: { type: 'string' } } } }] }],
  } : undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    invoke,
    agentGuidance: { getCatalog: vi.fn(async () => []), preview },
  } });
  return { invoke, preview };
}

it('resolves the selected provider in the explicit workspace and keeps captured additions distinct', async () => {
  const { preview } = setup();
  const view = render(<Provider store={createStore()}><AgentSetupPanel workspacePath="/workspace" /></Provider>);
  fireEvent.click(view.getByRole('tab', { name: 'Effective setup' }));
  expect((await view.findByLabelText('Resolved Nimbalyst guidance')).textContent).toBe('openai-codex saved guidance.');
  expect(preview).toHaveBeenLastCalledWith('/workspace', 'openai-codex');
  expect(view.getByText('Previously captured instructions.').textContent).toBe('Previously captured instructions.');
  fireEvent.change(view.getByRole('combobox', { name: 'Guidance preview provider' }), { target: { value: 'claude-code' } });
  await waitFor(() => expect(view.getByLabelText('Resolved Nimbalyst guidance').textContent).toBe('claude-code saved guidance.'));
  expect(preview).toHaveBeenLastCalledWith('/workspace', 'claude-code');
  expect(view.getByText('Previously captured instructions.').textContent).toBe('Previously captured instructions.');
});

it('discards a preview response from a workspace that is no longer selected', async () => {
  let resolveOld!: (value: AgentGuidancePreview) => void;
  const preview = vi.fn((_workspace: string, _provider: string) => new Promise<AgentGuidancePreview>(resolve => { resolveOld = resolve; }));
  setup(preview);
  const store = createStore();
  const view = render(<Provider store={store}><AgentSetupPanel workspacePath="/old" /></Provider>);
  fireEvent.click(view.getByRole('tab', { name: 'Effective setup' }));
  await waitFor(() => expect(preview).toHaveBeenCalledWith('/old', 'openai-codex'));
  preview.mockResolvedValueOnce({ provider: 'openai-codex', role: 'Developer instructions', scope: 'Baseline.', text: 'New workspace guidance.' });
  view.rerender(<Provider store={store}><AgentSetupPanel workspacePath="/new" /></Provider>);
  expect((await view.findByLabelText('Resolved Nimbalyst guidance')).textContent).toBe('New workspace guidance.');
  await act(async () => resolveOld({ provider: 'openai-codex', role: 'Developer instructions', scope: 'Baseline.', text: 'Old workspace guidance.' }));
  expect(view.getByLabelText('Resolved Nimbalyst guidance').textContent).toBe('New workspace guidance.');
});

it('inspects supplied tool schemas and keeps the saved toggle on a failed update', async () => {
  const { invoke } = setup();
  const view = render(<Provider store={createStore()}><AgentSetupPanel workspacePath="/workspace" /></Provider>);
  fireEvent.click(view.getByRole('tab', { name: 'Tools' }));
  const toggle = await view.findByRole('checkbox');
  expect(invoke).toHaveBeenCalledWith('mcp-config:get-tool-budget', '/workspace', true);
  expect(view.getByLabelText('Schema for tracker_read').textContent).toContain('"key"');
  invoke.mockRejectedValueOnce(new Error('Disk full'));
  fireEvent.click(toggle);
  await view.findByText('Disk full');
  expect((toggle as HTMLInputElement).checked).toBe(true);
});
