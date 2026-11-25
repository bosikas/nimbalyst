/**
 * Which sessions keep their full transcript in renderer memory.
 *
 * A session's messages (base64 image results included) used to stay in
 * `sessionStoreAtom` until its workspace closed. Transcript viewers now hold a
 * reference while mounted. Released transcripts share a payload budget and
 * a session count limit. Evicted transcripts reload when a viewer mounts again.
 */

import type { createStore } from 'jotai';
import { store as defaultStore } from '@nimbalyst/runtime/store';
import { evictSessionMessagesAtom, isSessionDataResident, sessionStoreAtom } from './atoms/sessions';

type Store = ReturnType<typeof createStore>;

export const RECENTLY_VIEWED_RETAINED = 8;
const RECENTLY_VIEWED_PAYLOAD_BUDGET = 8 * 1024 * 1024;

// Estimate the projected payload in place so large tool results and base64
// strings count toward the budget without making a serialized copy.
function estimatePayloadBytes(value: unknown, limit: number, depth = 0): number {
  if (typeof value === 'string') return 2 * value.length;
  if (!value || typeof value !== 'object') return 8;
  // Treat unusually deep or cyclic values as too large to cache.
  if (depth >= 32) return limit + 1;

  let bytes = 64;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (bytes > limit) break;
      bytes += 8 + estimatePayloadBytes(item, limit - bytes, depth + 1);
    }
  } else {
    for (const key in value) {
      if (bytes > limit) break;
      if (Object.hasOwn(value, key)) {
        bytes += 8 + estimatePayloadBytes((value as Record<string, unknown>)[key], limit - bytes, depth + 1);
      }
    }
  }
  return bytes;
}

export interface SessionViewRetention {
  acquire(sessionId: string): () => void;
  /** Evict what is no longer retained; call when a busy session settles. */
  sweep(): void;
}

export function createSessionViewRetention(store: Store, retained = RECENTLY_VIEWED_RETAINED): SessionViewRetention {
  const viewers = new Map<string, number>();
  // Released sessions, least recently viewed first.
  const recent: string[] = [];

  const sweep = () => {
    if (recent.length > retained) recent.splice(0, recent.length - retained);
    const keep = new Set(viewers.keys());
    let remainingBytes = RECENTLY_VIEWED_PAYLOAD_BUDGET;
    for (let index = recent.length - 1; index >= 0; index--) {
      const sessionId = recent[index];
      const data = store.get(sessionStoreAtom(sessionId));
      if (!data || !isSessionDataResident(data)) continue;
      const bytes = estimatePayloadBytes(data.messages, remainingBytes);
      if (bytes <= remainingBytes) {
        keep.add(sessionId);
        remainingBytes -= bytes;
      }
    }

    for (const sessionId of sessionStoreAtom.getParams()) {
      if (keep.has(sessionId) || !isSessionDataResident(store.get(sessionStoreAtom(sessionId)))) continue;
      // A busy session stays resident; the next sweep after it settles evicts it.
      store.set(evictSessionMessagesAtom, sessionId);
    }
  };

  return {
    acquire(sessionId) {
      viewers.set(sessionId, (viewers.get(sessionId) ?? 0) + 1);
      const index = recent.indexOf(sessionId);
      if (index >= 0) recent.splice(index, 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const count = (viewers.get(sessionId) ?? 1) - 1;
        if (count > 0) {
          viewers.set(sessionId, count);
          return;
        }
        viewers.delete(sessionId);
        recent.push(sessionId);
        sweep();
      };
    },
    sweep,
  };
}

export const sessionViewRetention = createSessionViewRetention(defaultStore);
