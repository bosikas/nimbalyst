import { store } from '@nimbalyst/runtime/store';
import type { TranscriptViewMessage } from '@nimbalyst/runtime/ai/server/transcript/TranscriptProjector';
import type { BrowserHostPromptReceipt, BrowserHostSession, BrowserHostSessionHistory } from '../../shared/browserHost';
import { sessionQueuedPromptsAtom } from '../store/atoms/sessionTranscript';
import {
  nextOptimisticId, sessionDraftHydratedAtom, sessionDraftInputAtom, sessionProcessingAtom, sessionStoreAtom,
} from '../store/atoms/sessions';
import { reconcileTranscriptMessages } from '../store/transcriptReconciliation';

let observation = 0;
const activityObservations = new Map<string, number>();
const draftWrites = new Map<string, Promise<void>>();
const pendingPrompts = new Map<string, {
  message: TranscriptViewMessage;
  receipt?: BrowserHostPromptReceipt & { acceptedAt: number };
}>();

export function nextBrowserObservation() {
  return ++observation;
}

export function watchBrowserDraft(id: string, save: (draft: string) => Promise<void>) {
  const draftAtom = sessionDraftInputAtom(id);
  let lastQueued = store.get(draftAtom);
  let timer: number | undefined;

  function flush() {
    window.clearTimeout(timer);
    timer = undefined;
    const draft = store.get(draftAtom);
    if (draft === lastQueued) return;
    lastQueued = draft;
    // Switching sessions can flush a draft while the previous save is still in flight.
    const write = (draftWrites.get(id) ?? Promise.resolve()).then(() => save(draft)).catch(() => {
      // The browser session shows save errors. Keep the local draft available.
    });
    draftWrites.set(id, write);
    void write.then(() => {
      if (draftWrites.get(id) === write) draftWrites.delete(id);
    });
  }

  const unsubscribe = store.sub(draftAtom, () => {
    if (!store.get(sessionDraftHydratedAtom(id))) {
      lastQueued = store.get(draftAtom);
      return;
    }
    window.clearTimeout(timer);
    timer = window.setTimeout(flush, 1000);
  });
  return () => {
    unsubscribe();
    if (timer !== undefined) flush();
  };
}

export function applyBrowserActivity(id: string, processing: boolean | undefined, observedAt: number) {
  if (processing === undefined || observedAt < (activityObservations.get(id) ?? 0)) return;
  activityObservations.set(id, observedAt);
  if (store.get(sessionProcessingAtom(id)) !== processing) store.set(sessionProcessingAtom(id), processing);
}

export function selectBrowserSession(
  selected: string,
  sessions: ReadonlyArray<Pick<BrowserHostSessionHistory[number], 'id' | 'isArchived'>>,
) {
  // A newly opened child can appear in history a poll after it is selected.
  return selected || sessions.find((session) => !session.isArchived)?.id || '';
}

export function showBrowserPrompt(id: string, text: string) {
  const session = store.get(sessionStoreAtom(id));
  if (!session || pendingPrompts.has(id) || store.get(sessionProcessingAtom(id)) ||
      store.get(sessionQueuedPromptsAtom(id)).length > 0) return;
  const message: TranscriptViewMessage = {
    id: nextOptimisticId(),
    sequence: -1,
    type: 'user_message',
    text,
    createdAt: new Date(),
    subagentId: null,
    optimistic: true,
  };
  pendingPrompts.set(id, { message });
  store.set(sessionStoreAtom(id), { ...session, messages: [...session.messages, message] });
  return message.id;
}

export function settleBrowserPrompt(id: string, optimisticId: number | undefined, receipt?: BrowserHostPromptReceipt) {
  const pending = pendingPrompts.get(id);
  if (!pending || pending.message.id !== optimisticId) return;
  if (receipt) {
    pendingPrompts.set(id, { ...pending, receipt: { ...receipt, acceptedAt: observation } });
    return;
  }
  pendingPrompts.delete(id);
  store.set(sessionStoreAtom(id), (session) => session && {
    ...session, messages: session.messages.filter((message) => message.id !== optimisticId),
  });
}

export function applyBrowserTranscript(
  snapshot: BrowserHostSession & { workspacePath: string },
  observedAt: number,
  unchanged = false,
) {
  const { id, messages, queuedPrompts = [], executingPromptIds } = snapshot;
  const pending = pendingPrompts.get(id);
  const current = store.get(sessionStoreAtom(id));
  // A snapshot started before enqueue completed may still be missing the prompt.
  if (pending && (!pending.receipt || observedAt <= pending.receipt.acceptedAt)) return;
  if (unchanged && !pending && current?.messages === messages) return;

  let transcript = messages;
  if (pending?.receipt) {
    if (executingPromptIds?.includes(pending.receipt.id)) {
      // Use the host's enqueue time when comparing against its saved messages.
      // The browser and host clocks are independent.
      const optimistic = { ...pending.message, createdAt: new Date(pending.receipt.createdAt) };
      transcript = reconcileTranscriptMessages(
        [...(current?.messages.filter((message) => message.id >= 0) ?? []), optimistic],
        messages,
      );
    }
    // Once queued behind another turn, cancelled, or saved, the host owns the row.
    if (!transcript.some((message) => message.id === pending.message.id)) pendingPrompts.delete(id);
  }
  store.set(sessionStoreAtom(id), { ...snapshot, messages: transcript });
  store.set(sessionQueuedPromptsAtom(id), queuedPrompts);
}
