import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { ThemeContribution } from '@nimbalyst/extension-sdk';

export interface BrowserHostSessionSummary {
  id: string;
  title: string;
}

export type BrowserHostSession = Pick<SessionData, 'id' | 'provider' | 'title' | 'messages' | 'createdAt' | 'updatedAt'>;

export interface BrowserHostInfo {
  workspaceName: string;
  workspacePath?: string;
  pdfName: string | null;
  appearance?: {
    theme: string;
    contribution?: { extensionId: string; theme: ThemeContribution };
  };
}

export interface BrowserHostExtension {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  panels?: BrowserHostPanel[];
}

export interface BrowserHostPanel {
  id: string;
  title: string;
  icon: string;
}

export type BrowserHostSchedule =
  | { type: 'daily'; time: string }
  | { type: 'weekly'; time: string; days: string[] }
  | { type: 'interval'; minutes: number };

export interface BrowserHostAutomation {
  title: string;
  prompt: string;
  schedule: BrowserHostSchedule;
}

export type BrowserHostApproval = 'allow' | 'deny';

export function pendingBrowserPermissions(messages: BrowserHostSession['messages']) {
  return messages.flatMap(({ interactivePrompt }) =>
    interactivePrompt?.promptType === 'permission_request' && interactivePrompt.status === 'pending'
      ? [interactivePrompt]
      : []);
}
