export type SessionMessageAnchor =
  | { kind: 'assistant' | 'user'; timestamp: number; quote: string }
  | { kind: 'widget'; promptId: string; timestamp: number };

export interface SessionNotificationNavigationTarget {
  sessionId: string;
  workspacePath: string;
  sourceLabel: string;
  messageAnchor?: SessionMessageAnchor;
}
