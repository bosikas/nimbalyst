import type { SessionData } from '@nimbalyst/runtime/ai/server/types';

export interface BrowserHostSessionSummary {
  id: string;
  title: string;
}

export type BrowserHostSession = Pick<SessionData, 'id' | 'provider' | 'title' | 'messages' | 'createdAt' | 'updatedAt'>;

export interface BrowserHostInfo {
  workspaceName: string;
  pdfName: string | null;
}
