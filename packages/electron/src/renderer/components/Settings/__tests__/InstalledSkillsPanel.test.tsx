import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { InstalledSkillsPanel } from '../InstalledSkillsPanel';

afterEach(cleanup);
const catalog = { skills: [{ name: 'fixture', path: '/skills/SKILL.md', description: 'Useful instructions', enabled: true, scope: 'user' }], errors: [] };
function setup() {
  const api = {
    listSkills: vi.fn(async () => catalog),
    setSkillEnabled: vi.fn(async () => ({ ...catalog, skills: [{ ...catalog.skills[0], enabled: false }] })),
    previewSkill: vi.fn(async () => 'Full fixture instructions'),
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { agentGuidance: api } });
  return api;
}

it('loads on demand, saves a native switch and keeps disabled skills available for inspection', async () => {
  const api = setup();
  const view = render(<InstalledSkillsPanel workspacePath="/workspace" />);
  expect(api.listSkills).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'Load skills' }));
  const toggle = await view.findByRole('checkbox', { name: 'fixture' });
  fireEvent.click(toggle);
  await waitFor(() => expect((toggle as HTMLInputElement).checked).toBe(false));
  expect(api.setSkillEnabled).toHaveBeenCalledWith('/workspace', '/skills/SKILL.md', false);
  const details = view.getByText('View instructions').closest('details')!;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  expect((await view.findByText('Full fixture instructions')).textContent).toBe('Full fixture instructions');
  expect(api.previewSkill).toHaveBeenCalledWith('/workspace', '/skills/SKILL.md');
});

it('retains confirmed enablement on native write failure and exposes the error', async () => {
  const api = setup();
  api.setSkillEnabled.mockRejectedValueOnce(new Error('native write denied'));
  const view = render(<InstalledSkillsPanel workspacePath="/workspace" />);
  fireEvent.click(view.getByRole('button', { name: 'Load skills' }));
  const toggle = await view.findByRole('checkbox', { name: 'fixture' });
  fireEvent.click(toggle);
  expect((await view.findByRole('alert')).textContent).toContain('native write denied');
  expect((toggle as HTMLInputElement).checked).toBe(true);
});

it('does not show late catalog results in another workspace', async () => {
  const api = setup();
  let resolve!: (value: typeof catalog) => void;
  api.listSkills.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const view = render(<InstalledSkillsPanel workspacePath="/first" />);
  fireEvent.click(view.getByRole('button', { name: 'Load skills' }));
  view.rerender(<InstalledSkillsPanel workspacePath="/second" />);
  resolve(catalog);
  await waitFor(() => expect((view.getByRole('button', { name: 'Load skills' }) as HTMLButtonElement).disabled).toBe(false));
  expect(view.queryByRole('checkbox')).toBeNull();
});
