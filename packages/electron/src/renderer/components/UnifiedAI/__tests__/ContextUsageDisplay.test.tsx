// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, cleanup } from '@testing-library/react';
import { ContextUsageDisplay } from '../ContextUsageDisplay';

vi.mock('@nimbalyst/runtime/ui/icons/MaterialSymbol', () => ({
  MaterialSymbol: () => null,
}));
vi.mock('../../../help', () => ({ getHelpContent: () => undefined }));

// inputTokens > 0 makes the breakdown panel eligible (enableTooltip).
const props = {
  provider: 'claude-code',
  inputTokens: 80_000,
  outputTokens: 20_000,
  totalTokens: 100_000,
  contextWindow: 200_000,
  currentContext: { tokens: 132_000, contextWindow: 200_000 },
};

afterEach(() => cleanup());

describe('ContextUsageDisplay - context meter opens on click, not hover (#429)', () => {
  it('refreshes observed native evidence while keeping the inspector open and separating configured tools', async () => {
    let refreshed = false;
    const invoke = vi.fn(async (_channel: string) => ({
      preparedRequest: null, unavailable: 'No prepared request yet.',
      toolDefinitions: { groups: [{ configKey: 'fixture', displayName: 'Fixture tools', enabled: true, loadPolicy: 'deferred', toolCount: 2 }] },
      nativeEvidence: {
        compactions: [{ id: 'compact', startedAt: 1, completedAt: 2, beforeTokens: 9000, afterTokens: refreshed ? 3000 : null }],
        observedTools: [{ server: 'fixture', tool: 'lookup', calls: 1, lastObservedAt: 2 }], omittedToolCalls: 0,
      },
    }));
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { invoke } });
    render(<ContextUsageDisplay {...props} provider="openai-codex" sessionId="evidence-session" />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    await screen.findByText(/Awaiting usage/);
    expect(screen.getByText(/Fixture tools: configured deferred/).textContent).toContain('2 definitions');
    expect(screen.getByText('fixture / lookup · 1 calls').textContent).toContain('lookup');
    refreshed = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh evidence' }));
    await screen.findByText('(-6,000 tokens)');
    expect(invoke.mock.calls.filter(([channel]) => channel === 'mcp-config:get-context-inspection')).toHaveLength(2);
    expect(screen.queryByRole('tooltip')).not.toBeNull();
  });
  it('keeps the panel open when expanding prepared context or using its keyboard controls', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
      invoke: vi.fn(async (channel: string) => channel === 'mcp-config:get-context-inspection'
        ? { preparedRequest: null, unavailable: 'No prepared request yet.' } : null),
    } });
    render(<ContextUsageDisplay {...props} provider="openai-codex" sessionId="inspection-session" />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    await screen.findByText('No prepared request yet.');
    const summary = screen.getByText('Inspect prepared context');
    fireEvent.click(summary);
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    expect(summary.closest('details')?.open).toBe(true);
    fireEvent.keyDown(summary, { key: 'Enter' });
    expect(screen.queryByRole('tooltip')).not.toBeNull();
    fireEvent.keyDown(summary, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('does NOT open the breakdown panel on hover', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.mouseEnter(screen.getByTestId('context-indicator'));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('toggles the panel open and closed on click', () => {
    render(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    fireEvent.click(meter);
    screen.getByRole('tooltip');
    fireEvent.click(meter);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes the panel on an outside click', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    screen.getByRole('tooltip');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('closes the panel on Escape', () => {
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    screen.getByRole('tooltip');
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('exposes the meter as a button with aria-expanded when a breakdown exists', () => {
    render(<ContextUsageDisplay {...props} />);
    const meter = screen.getByTestId('context-indicator');
    expect(meter.getAttribute('role')).toBe('button');
    expect(meter.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(meter);
    expect(meter.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('ContextUsageDisplay - cumulative rows are labeled as session totals (#824)', () => {
  it('labels the io breakdown as cumulative session totals when the header shows window fill', () => {
    // Header-right shows current window fill (132k / 200k) while the io rows
    // show cumulative session usage (100k). Without a label the two read as
    // the same quantity and contradict each other (#824: 76k vs 12,073).
    render(<ContextUsageDisplay {...props} />);
    fireEvent.click(screen.getByTestId('context-indicator'));
    screen.getByText('Session totals (cumulative)');
  });

  it('omits the session-totals label when there is no context window (header already says Token Usage)', () => {
    // contextWindow: 0 is the no-window state (hasContextWindow derives from
    // displayContextWindow > 0); the header then reads "Token Usage" and no
    // window-fill total renders, so there is no second quantity to label.
    render(
      <ContextUsageDisplay
        provider="openai"
        inputTokens={80_000}
        outputTokens={20_000}
        totalTokens={100_000}
        contextWindow={0}
      />
    );
    fireEvent.click(screen.getByTestId('context-indicator'));
    expect(screen.queryByText('Session totals (cumulative)')).toBeNull();
  });
});

describe('ContextUsageDisplay - measured provider support (#914)', () => {
  it('does not render an indicator for a provider that reports no usage', () => {
    render(
      <ContextUsageDisplay
        provider="copilot-cli"
        inputTokens={0}
        outputTokens={0}
        totalTokens={0}
        contextWindow={200_000}
        currentContext={{ tokens: 0, contextWindow: 200_000 }}
      />
    );

    expect(screen.queryByTestId('context-indicator')).toBeNull();
  });

  it('shows cumulative counts without inventing a percentage for count-only providers', () => {
    // contextWindow is deliberately non-zero: a catalog window must not turn
    // cumulative spend into a fill, whatever else is passed in.
    render(
      <ContextUsageDisplay
        provider="grok-build"
        inputTokens={80_000}
        outputTokens={20_000}
        totalTokens={100_000}
        contextWindow={200_000}
      />
    );

    // #914: never a fill percentage without a real denominator.
    expect(screen.getByTestId('context-indicator').textContent).not.toMatch(/%|\//);
  });
});
