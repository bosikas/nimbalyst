import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import type { SessionMeta } from '@nimbalyst/runtime/ai/adapters/sessionStore';
import type { ThemeContribution } from '@nimbalyst/extension-sdk';
import type { ClaudeUsageData } from './claudeUsage';
import type { CodexUsageData } from '../main/services/CodexUsageService';
import type { GeminiUsageData } from '../main/services/GeminiUsageService';
import type { MistralVibeProvider } from '@nimbalyst/runtime/ai/server';

export type VibeUsageData = Awaited<ReturnType<typeof MistralVibeProvider.readAccountUsage>>;
export type BrowserUsageProvider = 'claude' | 'codex' | 'gemini' | 'vibe';
export interface BrowserHostRailStatus {
  claude: ClaudeUsageData | null;
  codex: CodexUsageData | null;
  gemini: GeminiUsageData | null;
  vibe: VibeUsageData;
  badges: Record<string, { count: number; tone: 'default' | 'warning' }>;
}

export interface BrowserHostSessionSummary {
  id: string;
  title: string;
}

export type BrowserHostSessionHistory = (SessionMeta & { processing?: boolean })[];

export interface BrowserHostPromptReceipt {
  id: string;
  createdAt: number;
}

export type BrowserHostSession = Pick<SessionData,
  'id' | 'provider' | 'title' | 'messages' | 'createdAt' | 'updatedAt' | 'model' | 'mode' |
  'isArchived' | 'parentSessionId' | 'worktreeId' | 'worktreePath' | 'tokenUsage' | 'draftInput'
> & {
  processing?: boolean;
  queuedPrompts?: { id: string; prompt: string; timestamp: number }[];
  executingPromptIds?: string[];
  metadata?: Partial<Pick<NonNullable<SessionData['metadata']>, 'effortLevel' | 'thinkingMode' | 'sessionStatus' | 'currentTodos'>>;
};

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
  order?: number;
  sessionAccess?: boolean;
}

export interface BrowserWorkspaceEvents {
  folders: string[];
  gitRevision: number;
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
