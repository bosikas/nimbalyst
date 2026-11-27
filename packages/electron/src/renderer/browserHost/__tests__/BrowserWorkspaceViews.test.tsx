import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type { BrowserHostPanel } from '../../../shared/browserHost';
import { BrowserWorkspaceViews } from '../BrowserExtensions';

vi.mock('../BrowserPanel', () => ({
  BrowserPanel: ({ panel, openSession, openFile }: {
    panel: BrowserHostPanel; openSession: (id: string) => void; openFile: (path: string) => void;
  }) => (
    <section aria-label={panel.title}>
      <button type="button" onClick={() => openSession('linked-session')}>Open linked session</button>
      <button type="button" onClick={() => openFile('outputs/SPEC.md')}>Open linked file</button>
    </section>
  ),
}));

it('opens an extension directly from the rail and returns to Sessions from a panel link', async () => {
  const openSession = vi.fn();
  const openFile = vi.fn();
  const request = vi.fn(async (path: string) => path.startsWith('/rail-status') ? Response.json({
    claude: null, codex: null, gemini: null,
    vibe: { utilization: 23, resetsAt: null },
    badges: { 'runtime.runtime': { count: 7, tone: 'warning' } },
  }) : Response.json([
    {
      id: 'runtime', name: 'Runtime', version: '1.0.0', enabled: true,
      panels: [{ id: 'runtime', title: 'Runtime', icon: 'dns', order: 59 }],
    },
    {
      id: 'backlog', name: 'Backlog', version: '1.0.0', enabled: true,
      panels: [{ id: 'backlog', title: 'Backlog', icon: 'checklist', order: 56 }],
    },
  ]));
  render(
    <BrowserWorkspaceViews request={request} pdf={null} pdfName={null}
      workspacePath="/workspace" openSession={openSession} onOpenFile={openFile}>
      <h2>Session transcript</h2>
    </BrowserWorkspaceViews>,
  );
  const rail = within(screen.getByRole('navigation', { name: 'Workspace views' }));
  const backlog = await rail.findByRole('button', { name: 'Backlog' });
  const runtime = rail.getByRole('button', { name: 'Runtime' });
  expect((await within(runtime).findByText('7')).getAttribute('data-tone')).toBe('warning');
  const vibe = rail.getByRole('button', { name: 'Mistral Vibe Usage' });
  expect(await within(vibe).findByText('23%')).toBeTruthy();
  fireEvent.click(vibe);
  expect(await screen.findByText('23% of the monthly allowance used')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); });
  expect(request).toHaveBeenCalledWith('/rail-status?refresh=vibe', expect.anything());
  fireEvent.click(vibe);
  const icons = rail.getAllByRole('button');
  expect(icons.indexOf(backlog)).toBeLessThan(icons.indexOf(runtime));
  fireEvent.click(backlog);
  expect(backlog.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('heading', { name: 'Session transcript' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open linked file' }));
  expect(openFile).toHaveBeenCalledWith('/workspace/outputs/SPEC.md');
  expect(backlog.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(within(screen.getByRole('region', { name: 'Backlog' })).getByRole('button', { name: 'Open linked session' }));
  expect(openSession).toHaveBeenCalledWith('linked-session');
  expect(rail.getByRole('button', { name: 'Sessions' }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.getByRole('heading', { name: 'Session transcript' }).textContent).toBe('Session transcript');
});
