import type { DocumentContext } from '@nimbalyst/runtime/ai/server/types';

/** Preserve queue provenance across the streaming handler's document-context rebuild. */
export function turnPromptAuthorship(context: DocumentContext | undefined, queuedPromptId?: string): Pick<DocumentContext, 'promptProvenance' | 'coalescedPrompts'> {
  return {
    coalescedPrompts: context?.coalescedPrompts,
    promptProvenance: context?.promptProvenance ?? (queuedPromptId ? undefined : { actor: 'human', origin: 'composer' }),
  };
}
