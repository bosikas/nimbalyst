// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('posthog-js/react', () => ({ usePostHog: () => ({ capture: vi.fn() }) }));
vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({ MaterialSymbol: () => null }));
vi.mock('../../../../hooks/useTheme', () => ({ useTheme: () => ({ theme: 'light' }) }));
vi.mock('../../../../store/atoms/appSettings', async () => {
  const { atom } = await import('jotai');
  return { enabledProvidersAtom: atom(['claude-code', 'openai-codex']) };
});
vi.mock('../../../../dialogs/requestConfirmation', () => ({ requestConfirmation: vi.fn(async () => true) }));
vi.mock('../../../../services/ErrorNotificationService', () => ({ errorNotificationService: { showError: vi.fn() } }));

import { MCPServersPanel } from '../MCPServersPanel';

type Config = { mcpServers: Record<string, Record<string, unknown>> };

function installConfig(initial: Config) {
  let stored: Config = structuredClone(initial);
  const writes: Config[] = [];
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'mcp-config:read-user') return structuredClone(stored);
    if (channel === 'mcp-config:validate') return { valid: true };
    if (channel === 'mcp-config:check-oauth-status') return { authorized: false, requiresOAuth: false };
    if (channel === 'mcp-config:write-user') {
      stored = structuredClone(args[0] as Config);
      writes.push(stored);
      return { success: true };
    }
    return null;
  });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke, on: () => () => {} } });
  return { writes, current: () => stored };
}

afterEach(() => cleanup());

describe('MCP server Codex tool loading', () => {
  it('writes the per-server Codex choice to mcp.json and keeps hand-edited values through other edits', async () => {
    const config = installConfig({ mcpServers: {
      design: { command: 'design-server', omit_tools_from: ['direct'] },
      claudeOnly: { command: 'claude-server', enabledForProviders: ['claude-agent'] },
      nimbalyst: { type: 'http', url: 'http://127.0.0.1/mcp' },
    } });
    render(<MCPServersPanel />);
    fireEvent.click(await screen.findByText('design'));

    // A hand-edited value is shown as custom and survives an unrelated edit.
    const select = await screen.findByLabelText('Load tool details (Codex)') as HTMLSelectElement;
    expect(select.value).toBe('custom');
    fireEvent.blur(screen.getByLabelText('Server Name'));
    await waitFor(() => expect(config.writes.length).toBe(1));
    expect(config.current().mcpServers.design.omit_tools_from).toEqual(['direct']);

    fireEvent.change(select, { target: { value: 'at-startup' } });
    await waitFor(() => expect(config.current().mcpServers.design.omit_tools_from).toEqual(['deferred']));
    expect(config.current().mcpServers.design.command).toBe('design-server');

    fireEvent.change(screen.getByLabelText('Load tool details (Codex)'), { target: { value: 'when-needed' } });
    await waitFor(() => expect(config.current().mcpServers.design).not.toHaveProperty('omit_tools_from'));
    expect(config.current().mcpServers.claudeOnly).toEqual({ command: 'claude-server', enabledForProviders: ['claude-agent'] });

    // No control where it would have no effect: Codex disabled for the server, or the core server.
    fireEvent.click(screen.getByText('claudeOnly'));
    await screen.findByDisplayValue('claude-server');
    expect(screen.queryByLabelText('Load tool details (Codex)')).toBeNull();
    fireEvent.click(screen.getByText('nimbalyst'));
    await screen.findByDisplayValue('http://127.0.0.1/mcp');
    expect(screen.queryByLabelText('Load tool details (Codex)')).toBeNull();
  });
});
