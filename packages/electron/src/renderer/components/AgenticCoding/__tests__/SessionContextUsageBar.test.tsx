// @vitest-environment jsdom
import React from 'react';
import { Provider } from 'jotai';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { store } from '@nimbalyst/runtime/store';
import { SessionContextUsageBar } from '../SessionContextUsageBar';
import { sessionRegistryAtom, sessionStoreAtom, type SessionMeta } from '../../../store/atoms/sessions';
import { setShowContextUsageAtom } from '../../../store/atoms/agentMode';
import { initWorkstreamState } from '../../../store/atoms/workstreamState';
import { activeWorkspacePathAtom } from '../../../store/atoms/openProjects';

const id = 'inline-context-fixture';
function view() { return render(<Provider store={store}><SessionContextUsageBar sessionId={id} /></Provider>); }
beforeEach(() => {
  initWorkstreamState('/inline-context-preview');
  store.set(activeWorkspacePathAtom, '/inline-context-preview');
  store.set(setShowContextUsageAtom, true);
  store.set(sessionStoreAtom(id), null);
  store.set(sessionRegistryAtom, new Map([[id, { id, provider: 'openai-codex', contextUsage: { tokens: 42000, contextWindow: 200000 } } as SessionMeta]]));
});
afterEach(() => { cleanup(); store.set(sessionStoreAtom(id), null); store.set(setShowContextUsageAtom, false); });

describe('session context line and hover details', () => {
  it('shows measured fill with full token counts available to assistive technology', () => {
    view();
    expect(screen.getByRole('meter', { name: 'Context 42k / 200k (21%)' }).getAttribute('aria-valuenow')).toBe('21');
    expect(screen.getByRole('meter').textContent).toBe('');
  });

  it('does not show cumulative usage as a current fill or resurrect a stale snapshot', () => {
    // A loaded, compacted session can retain spend counters without a current snapshot.
    store.set(sessionStoreAtom(id), { tokenUsage: { inputTokens: 180000, outputTokens: 30000 } } as any);
    view();
    expect(screen.queryByRole('meter')).toBeNull();
    render(<Provider store={store}><SessionContextUsageBar sessionId={id} variant="details" /></Provider>);
    expect(screen.getByText('Context —').getAttribute('title')).toContain('No current');
  });

  it('updates from the live current-context measurement', () => {
    view();
    act(() => store.set(sessionStoreAtom(id), { tokenUsage: { currentContext: { tokens: 180000, contextWindow: 200000 } } } as any));
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('90');
  });

  it('retains the existing context-display preference', () => {
    store.set(setShowContextUsageAtom, false);
    const result = view();
    expect(result.container.textContent).toBe('');
    expect(screen.queryByRole('meter')).toBeNull();
  });

  it('keeps exact context counts accessible in hover details when the row meter is disabled', () => {
    store.set(setShowContextUsageAtom, false);
    render(<Provider store={store}><SessionContextUsageBar sessionId={id} variant="details" /></Provider>);
    expect(screen.getByText('Context: 42,000 / 200,000 tokens (21%)').textContent).toContain('42,000');
  });
});
