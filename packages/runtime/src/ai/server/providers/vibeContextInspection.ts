import type { ProtocolMessage, ProtocolSession } from '../protocols/ProtocolInterface';
import type { PreparedContextRequest } from './preparedContextInspection';

const latest = new Map<string, { request: PreparedContextRequest; instructions?: string }>();
const retainedSessions = 64;
const retainedCharacters = 16384;

export function recordVibePreparedContext(
  session: ProtocolSession,
  message: ProtocolMessage,
  systemPrompt: string | undefined,
  attachmentCount: number,
): void {
  if (!message.sessionId) return;
  const guidance = systemPrompt ?? '';
  const request: PreparedContextRequest = {
    measuredAt: Date.now(),
    scope: 'Last Nimbalyst-prepared Vibe request, before native processing. Sizes are UTF-8 text bytes.',
    categories: [
      { name: 'Nimbalyst guidance', bytes: Buffer.byteLength(guidance), reason: 'Host instructions supplied as an ACP resource with the prompt.' },
      { name: 'User input and document additions', bytes: Buffer.byteLength(message.content), reason: 'Current input and document context included in the ACP text block.' },
    ],
    configuredMcpServers: session.deliveredMcpServerCount ?? 0,
    attachments: attachmentCount,
    nativeContext: 'Vibe assembles the system prompt, instructions, skills, tool schemas, and conversation history after receiving the ACP request.',
  };
  const instructions = guidance.length > retainedCharacters
    ? guidance.slice(0, retainedCharacters) + '\n[Preview truncated]'
    : guidance || undefined;

  latest.delete(message.sessionId);
  latest.set(message.sessionId, { request, instructions });
  if (latest.size > retainedSessions) latest.delete(latest.keys().next().value!);
}

export function readVibePreparedContext(sessionId: string) {
  return latest.get(sessionId);
}
