import React from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolActivityGroup } from '../ToolActivityGroup';
import { BashWidget } from '../CustomToolWidgets/BashWidget';
import type { TranscriptToolEntry } from '../TranscriptMessageRow';

vi.mock('../ToolCallChanges', () => ({ ToolCallChanges: () => null }));

afterEach(cleanup);
const entry = (index: number, toolName: string, status = 'completed', isExpanded = false) => ({
  index, isExpanded, superseded: false,
  message: { id: index, type: 'tool_call', toolCall: { toolName, status } },
} as TranscriptToolEntry);
const renderEntry = (e: TranscriptToolEntry) => e.message.toolCall?.toolName === 'AskUserQuestion'
  ? <button key={e.index}>Answer the question</button>
  : <pre key={e.index}>{e.message.toolCall?.toolName}: complete evidence</pre>;

describe('activity interaction', () => {
  it('keeps a single session action and its session link directly accessible', () => {
    render(<ToolActivityGroup entries={[entry(0, 'mcp__nimbalyst__send_prompt')]} isProcessing={false} renderEntry={() => <button>Open reviewer session</button>} />);
    expect(screen.getByRole('button', { name: 'Open reviewer session' }).closest('[hidden]')).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
  it('does not count or preview superseded tool events', () => {
    const old = { ...entry(0, 'Read'), superseded: true };
    render(<ToolActivityGroup entries={[old, entry(1, 'Bash')]} isProcessing={false} renderEntry={renderEntry} />);
    expect(screen.queryByText('Read file')).toBeNull();
    expect(screen.getByText('Run command').textContent).toBe('Run command');
  });
  it('shows useful single-tool input before expansion and retains complete evidence', () => {
    const tool = entry(0, 'Read');
    Object.assign(tool.message.toolCall!, { arguments: { file_path: '/project/grouping.ts' }, result: 'Original file contents' });
    render(<ToolActivityGroup entries={[tool]} isProcessing={false} renderEntry={renderEntry} />);
    expect(screen.getByText('Read file').textContent).toBe('Read file');
    expect(screen.getByText('/project/grouping.ts').textContent).toBe('/project/grouping.ts');
    expect(screen.queryByText('Read: complete evidence')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Read file/ }));
    expect(screen.getByText('Read: complete evidence').textContent).toBe('Read: complete evidence');
  });
  it('keeps pairs descriptive and groups a longer run without losing entries', () => {
    const tools = [entry(0, 'Read'), entry(1, 'Bash'), entry(2, 'Read')];
    const { rerender } = render(<ToolActivityGroup entries={tools.slice(0, 2)} isProcessing={false} renderEntry={renderEntry} />);
    expect(screen.getAllByRole('button')).toHaveLength(2);
    rerender(<ToolActivityGroup entries={tools} isProcessing={false} renderEntry={renderEntry} />);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getAllByText('Read: complete evidence')).toHaveLength(2);
    expect(screen.getByText('Bash: complete evidence').textContent).toBe('Bash: complete evidence');
  });
  it.each(['status', 'flag'])('shows a failed shell row when the tool-level %s marks the activity as failed', kind => {
    const failed = entry(0, 'command_execution', kind === 'status' ? 'error' : 'completed');
    failed.message.createdAt = new Date();
    Object.assign(failed.message.toolCall!, { arguments: { command: 'cat missing-file' }, result: 'No such file or directory', ...(kind === 'flag' ? { isError: true } : {}) });
    const renderShell = (e: TranscriptToolEntry) => <BashWidget key={e.index} message={e.message} isExpanded={false} onToggle={() => {}} />;
    const { rerender } = render(<ToolActivityGroup entries={[failed]} isProcessing={false} renderEntry={renderShell} />);
    expect(screen.getByRole('button', { name: /Run command.*Failed/ }).getAttribute('aria-expanded')).toBe('true');
    const command = within(document.querySelector('.transcript-tool-activity-steps') as HTMLElement).getByRole('button', { name: /cat missing-file/ });
    expect(command.querySelectorAll('.text-nim-success svg').length).toBe(0);
    expect(command.querySelectorAll('.text-nim-error svg').length).toBe(1);
    const succeeded = { ...failed, message: { ...failed.message, toolCall: { ...failed.message.toolCall!, status: 'completed' as const, isError: false, result: 'File contents' } } };
    rerender(<ToolActivityGroup entries={[succeeded]} isProcessing={false} renderEntry={renderShell} />);
    fireEvent.click(screen.getByRole('button', { name: /Completed/ }));
    const completed = within(document.querySelector('.transcript-tool-activity-steps') as HTMLElement).getByRole('button', { name: /cat missing-file/ });
    expect(completed.querySelectorAll('.text-nim-success svg').length).toBe(1);
    expect(completed.querySelectorAll('.text-nim-error svg').length).toBe(0);
  });
  it('keeps the question actionable while completed output is disclosed on demand', () => {
    render(<ToolActivityGroup entries={[entry(0, 'Read'), entry(1, 'AskUserQuestion', 'running'), entry(2, 'Bash')]} isProcessing={false} renderEntry={renderEntry} />);
    expect(screen.getByRole('button', { name: 'Answer the question' }).closest('[hidden]')).toBeNull();
    expect(screen.queryByText('Read: complete evidence')).toBeNull();
    const toggle = screen.getAllByRole('button', { name: /Completed/ })[0];
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Read: complete evidence').textContent).toBe('Read: complete evidence');
    fireEvent.click(toggle);
    expect(screen.queryByText('Read: complete evidence')).toBeNull();
    expect(screen.getByRole('button', { name: 'Answer the question' }).closest('[hidden]')).toBeNull();
  });
  it('reopens the same deep link after a user closes its group', () => {
    const view = (sequence: number) => <ToolActivityGroup entries={[entry(0, 'Read')]} isProcessing={false} renderEntry={renderEntry} reveal={{ toolIndex: 0, sequence }} />;
    const { rerender } = render(view(1));
    const toggle = screen.getByRole('button', { name: /Completed/ });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    rerender(view(2));
    expect(screen.getByRole('button', { name: /Completed/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Read: complete evidence').textContent).toBe('Read: complete evidence');
  });
  it('collapses finished work and reveals search-selected tools again', () => {
    const view = (status: string, processing: boolean, selected = false) => <ToolActivityGroup entries={[entry(0, 'Bash', status, selected)]} isProcessing={processing} renderEntry={renderEntry} />;
    const { rerender } = render(view('running', true));
    expect(screen.getByRole('button', { name: /Working/ }).getAttribute('aria-expanded')).toBe('true');
    rerender(view('completed', false));
    const toggle = screen.getByRole('button', { name: /Completed/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    rerender(view('completed', false, true));
    expect(screen.getByRole('button', { name: /Completed/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Bash: complete evidence').textContent).toBe('Bash: complete evidence');
    fireEvent.click(screen.getByRole('button', { name: /Completed/ }));
    expect(screen.queryByText('Bash: complete evidence')).toBeNull();
  });
});
