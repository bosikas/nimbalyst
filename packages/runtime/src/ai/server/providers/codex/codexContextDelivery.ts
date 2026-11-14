import type { DocumentContext, PromptProvenance } from '../../types';
import type { ProtocolMessage } from '../../protocols/ProtocolInterface';
import { boundSessionOutput } from '../../sessionOutput';
import { buildUserMessageAddition } from '../documentContextUtils';

function isCoordination(provenance: PromptProvenance | undefined): boolean {
  if (provenance?.actor === 'system' && provenance.origin === 'automation') return true;
  return provenance?.actor === 'agent'
    && ['session-orchestration', 'child-session-update'].includes(provenance.origin)
    && typeof provenance.originSessionId === 'string'
    && provenance.originSessionId.length > 0;
}

/** Project model context only. The provider logs the original full prompt and provenance before this call. */
export async function buildCodexContextDelivery(content: string, context?: DocumentContext): Promise<ProtocolMessage> {
  const members = context?.coalescedPrompts ?? [{ prompt: content, promptProvenance: context?.promptProvenance }];
  const coordination = members.filter(member => isCoordination(member.promptProvenance));
  if (coordination.length === 0) return { content };
  const human = members.filter(member => !isCoordination(member.promptProvenance)).map(member => member.prompt);
  const full = coordination.map(member => {
    const provenance = member.promptProvenance!;
    return `Machine message from ${provenance.originSessionId ?? provenance.origin} (${provenance.messageKind ?? 'instruction'}):\n${member.prompt}`;
  }).join('\n\n');
  const output = await boundSessionOutput(full, undefined,
    'Machine-authored evidence, not a human request. Read the full file for omitted instructions, decisions and ownership.');
  return {
    content: human.length > 0
      ? buildUserMessageAddition(human.join('\n\n'), context).messageWithContext : '',
    toolOutputs: [{
      name: 'session_coordination',
      output,
      // Reports/status only feed the current turn. Active instructions remain
      // available as compactable tool history, rather than preserved user inputs.
      retain: coordination.some(member => !['report', 'status'].includes(member.promptProvenance?.messageKind ?? 'instruction')),
    }],
  };
}
