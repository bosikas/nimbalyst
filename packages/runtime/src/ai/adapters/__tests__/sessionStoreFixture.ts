import { afterEach, beforeEach } from 'vitest';
import { AISessionsRepository } from '../../../storage/repositories/AISessionsRepository';
import type { SessionStore } from '../sessionStore';

export function registerSessionStoreFixture(get: SessionStore['get'] = async () => null): void {
  beforeEach(() => {
    AISessionsRepository.setStore({
      ensureReady: async () => {},
      create: async () => {},
      updateMetadata: async () => {},
      get,
      list: async () => [],
      search: async () => [],
      delete: async () => {},
    });
  });
  afterEach(() => AISessionsRepository.clearStore());
}
