import { store } from '@nimbalyst/runtime/store';
import { expect, it } from 'vitest';
import type { BrowserHostSession } from '../../../shared/browserHost';
import { sessionQueuedPromptsAtom } from '../../store/atoms/sessionTranscript';
import { sessionProcessingAtom, sessionStoreAtom } from '../../store/atoms/sessions';
import {
  applyBrowserActivity, applyBrowserTranscript, nextBrowserObservation, selectBrowserSession,
  settleBrowserPrompt, showBrowserPrompt,
} from '../browserSessionState';

function session(id: string): BrowserHostSession & { workspacePath: string } {
  return {
    id, title: id, workspacePath: '/workspace', provider: 'mistral-vibe',
    createdAt: Date.now(), updatedAt: Date.now(), messages: [],
  };
}

it('updates an unopened session and ignores a slower, older activity poll', () => {
  const id = 'background';
  const stalePoll = nextBrowserObservation();
  const runningPoll = nextBrowserObservation();
  applyBrowserActivity(id, true, runningPoll);
  applyBrowserActivity(id, false, stalePoll);
  expect(store.get(sessionStoreAtom(id))).toBeNull();
  expect(store.get(sessionProcessingAtom(id))).toBe(true);

  applyBrowserActivity(id, false, nextBrowserObservation());
  expect(store.get(sessionProcessingAtom(id))).toBe(false);
});

it('retains the default selection when another session moves to the top of history', () => {
  const first = { id: 'first', isArchived: false };
  const second = { id: 'second', isArchived: false };
  const selected = selectBrowserSession('', [first, second]);
  expect(selected).toBe('first');
  expect(selectBrowserSession(selected, [second, first])).toBe('first');
  expect(selectBrowserSession('new-child', [second, first])).toBe('new-child');
});

it('shows the first prompt before the host acknowledges it, then replaces it with the saved row', () => {
  const snapshot = session('first-prompt');
  const transcript = sessionStoreAtom(snapshot.id);
  applyBrowserTranscript(snapshot, nextBrowserObservation());
  const stalePoll = nextBrowserObservation();
  const optimisticId = showBrowserPrompt(snapshot.id, 'Run checks');
  expect(store.get(transcript)?.messages).toMatchObject([{ id: optimisticId, text: 'Run checks', optimistic: true }]);

  // The Linux clock is behind this browser's clock.
  settleBrowserPrompt(snapshot.id, optimisticId, { id: 'receipt', createdAt: 1_000 });
  applyBrowserTranscript(snapshot, stalePoll);
  expect(store.get(transcript)?.messages[0].id).toBe(optimisticId);
  const executing = { ...snapshot, executingPromptIds: ['receipt'] };
  applyBrowserTranscript(executing, nextBrowserObservation());
  expect(store.get(transcript)?.messages[0].id).toBe(optimisticId);

  const saved = {
    id: 1, sequence: 1, type: 'user_message' as const, text: 'Run checks',
    createdAt: new Date(2_000), subagentId: null,
  };
  applyBrowserTranscript({ ...executing, messages: [saved] }, nextBrowserObservation());
  expect(store.get(transcript)?.messages).toEqual([saved]);
});

it('rolls back a failed send and shows queued follow-ups in the queue', () => {
  const snapshot = session('retry');
  const transcript = sessionStoreAtom(snapshot.id);
  applyBrowserTranscript(snapshot, nextBrowserObservation());
  const failed = showBrowserPrompt(snapshot.id, 'Retry');
  settleBrowserPrompt(snapshot.id, failed);
  expect(store.get(transcript)?.messages).toEqual([]);

  const retry = showBrowserPrompt(snapshot.id, 'Retry');
  const receipt = { id: 'queued-retry', createdAt: 1_000 };
  settleBrowserPrompt(snapshot.id, retry, receipt);
  const queued = { id: receipt.id, prompt: 'Retry', timestamp: receipt.createdAt };
  applyBrowserTranscript({ ...snapshot, queuedPrompts: [queued] }, nextBrowserObservation());
  expect(store.get(transcript)?.messages).toEqual([]);
  expect(store.get(sessionQueuedPromptsAtom(snapshot.id))).toEqual([queued]);
  expect(showBrowserPrompt(snapshot.id, 'Follow up')).toBeUndefined();
});
