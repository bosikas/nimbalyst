import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import type { CodexBaseInstructionsSource } from '@nimbalyst/runtime/ai/builtInGuidance';
import { CodexBasePromptPanel } from '../CodexBasePromptPanel';

afterEach(cleanup);

function setup(initial: CodexBaseInstructionsSource = {}) {
  let base = initial;
  let version = 0;
  const api = {
    getCodexBase: vi.fn(async () => base),
    updateCodexBase: vi.fn(async (text: string | null) => {
      base = text === null ? {} : { sourcePath: `/guidance/codex-base-${++version}.md`, text };
      return base;
    }),
    selectCodexBaseSource: vi.fn(async (filePath: string) => { base = { sourcePath: filePath, text: `Contents of ${filePath}` }; return base; }),
  };
  const openFileDialog = vi.fn(async () => ({ canceled: false, filePaths: ['/prompts/base.md'] }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { openFileDialog, agentGuidance: api } });
  return { api, openFileDialog, setBase: (next: CodexBaseInstructionsSource) => { base = next; } };
}

const preview = (view: ReturnType<typeof render>) => view.getByLabelText('Custom Codex base prompt').textContent;

it('starts provider-owned with an empty editor, keeps a draft through a failed save, and shows the saved file on retry', async () => {
  const { api } = setup();
  const view = render(<CodexBasePromptPanel />);
  expect((await view.findByText(/Provider default \(owned by Codex\)/)).textContent).toContain('Provider default');
  expect(view.queryByLabelText('Custom Codex base prompt')).toBeNull();
  fireEvent.click(view.getByRole('button', { name: 'Write custom Codex base prompt' }));
  const editor = view.getByRole('textbox', { name: 'Codex base prompt' }) as HTMLTextAreaElement;
  expect(editor.value).toBe('');
  fireEvent.change(editor, { target: { value: 'My base.' } });
  api.updateCodexBase.mockRejectedValueOnce(new Error('Disk full'));
  fireEvent.click(view.getByRole('button', { name: 'Save Codex base prompt' }));
  expect((await view.findByRole('alert')).textContent).toContain('Disk full');
  expect((view.getByRole('textbox', { name: 'Codex base prompt' }) as HTMLTextAreaElement).value).toBe('My base.');
  fireEvent.click(view.getByRole('button', { name: 'Save Codex base prompt' }));
  expect((await view.findByText('/guidance/codex-base-1.md')).textContent).toBe('/guidance/codex-base-1.md');
  expect(api.updateCodexBase).toHaveBeenLastCalledWith('My base.');
  expect(view.queryByRole('alert')).toBeNull();
  expect(view.queryByRole('textbox', { name: 'Codex base prompt' })).toBeNull();
  expect(preview(view)).toBe('My base.');
});

it('selects an existing Markdown file, seeds the editor with its saved text, and resets to the provider default', async () => {
  const { api, openFileDialog } = setup();
  const view = render(<CodexBasePromptPanel />);
  openFileDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
  fireEvent.click(await view.findByRole('button', { name: 'Choose Markdown file for Codex base prompt' }));
  await waitFor(() => expect(openFileDialog).toHaveBeenCalledTimes(1));
  expect(api.selectCodexBaseSource).not.toHaveBeenCalled();
  fireEvent.click(view.getByRole('button', { name: 'Choose Markdown file for Codex base prompt' }));
  expect((await view.findByText('/prompts/base.md')).textContent).toBe('/prompts/base.md');
  expect(openFileDialog).toHaveBeenLastCalledWith(expect.objectContaining({ filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }] }));
  expect(preview(view)).toBe('Contents of /prompts/base.md');
  fireEvent.click(view.getByRole('button', { name: 'Edit Codex base prompt' }));
  const editor = view.getByRole('textbox', { name: 'Codex base prompt' }) as HTMLTextAreaElement;
  expect(editor.value).toBe('Contents of /prompts/base.md');
  fireEvent.change(editor, { target: { value: 'Contents of /prompts/base.md\nPlus my rule.' } });
  fireEvent.click(view.getByRole('button', { name: 'Save Codex base prompt' }));
  expect((await view.findByText('/guidance/codex-base-1.md')).textContent).toBe('/guidance/codex-base-1.md');
  expect(preview(view)).toBe('Contents of /prompts/base.md\nPlus my rule.');
  fireEvent.click(view.getByRole('button', { name: 'Reset Codex base prompt to provider default' }));
  await waitFor(() => expect(api.updateCodexBase).toHaveBeenLastCalledWith(null));
  expect((await view.findByText(/Provider default \(owned by Codex\)/)).textContent).toContain('Provider default');
  expect(view.queryByText('/guidance/codex-base-1.md')).toBeNull();
  expect(view.queryByLabelText('Custom Codex base prompt')).toBeNull();
});

it('keeps an unreadable source visible and recoverable, and reloads external edits', async () => {
  const { api, setBase } = setup({ sourcePath: '/prompts/gone.md', error: 'Cannot open guidance source /prompts/gone.md: ENOENT' });
  const view = render(<CodexBasePromptPanel />);
  expect((await view.findByRole('alert')).textContent).toContain('ENOENT');
  expect(view.getByText('/prompts/gone.md').textContent).toBe('/prompts/gone.md');
  api.selectCodexBaseSource.mockRejectedValueOnce(new Error('Guidance source is empty'));
  fireEvent.click(view.getByRole('button', { name: 'Choose Markdown file for Codex base prompt' }));
  await waitFor(() => expect(view.getAllByRole('alert').some(node => node.textContent?.includes('Guidance source is empty'))).toBe(true));
  expect(view.getByText('/prompts/gone.md').textContent).toBe('/prompts/gone.md');
  setBase({ sourcePath: '/prompts/gone.md', text: 'Restored outside Nimbalyst.' });
  fireEvent.click(view.getByRole('button', { name: 'Reload Codex base prompt' }));
  await waitFor(() => expect(view.queryByRole('alert')).toBeNull());
  expect(preview(view)).toBe('Restored outside Nimbalyst.');
});
