import { AISessionsRepository } from '../../../storage/repositories/AISessionsRepository';

interface Selection {
  directive?: string;
  skipDefaultInstructions: boolean;
  codexSourceHome?: string;
  nativeMultiAgent?: boolean;
  readOnly?: boolean;
  startupSkills?: string[];
}

/**
 * Reads `metadata.sessionDirective` once per session and freezes it.
 *
 * The directive is part of the system prompt, which providers re-send at the
 * head of the prompt-cache prefix every turn (NIM-1988): a value that changed
 * mid-session would bust the whole cache. The selected file and native default
 * exclusion share that snapshot. A failed read blocks the turn and can retry;
 * silently falling back would load instructions the caller explicitly excluded.
 */
export class FrozenSessionDirectives {
  private readonly frozen = new Map<string, Promise<Selection>>();

  selection(sessionId?: string): Promise<Selection> {
    if (!sessionId) return Promise.resolve({ skipDefaultInstructions: false });
    let directive = this.frozen.get(sessionId);
    if (!directive) {
      directive = Promise.resolve()
        .then(() => AISessionsRepository.get(sessionId))
        .then((session) => {
          const metadata = session?.metadata as Record<string, unknown> | undefined;
          const value = metadata?.sessionDirective;
          const snapshot = metadata?.instructionSnapshot as { path?: string; content?: string } | undefined;
          const parts = [typeof value === 'string' && value.trim() ? value : undefined];
          if (typeof snapshot?.content === 'string' && snapshot.content.trim()) {
            parts.push(`Session instruction file: ${snapshot.path ?? 'selected profile'}\n${snapshot.content}`);
          }
          return {
            directive: parts.filter(Boolean).join('\n\n') || undefined,
            skipDefaultInstructions: metadata?.skipDefaultInstructions === true,
            codexSourceHome: typeof metadata?.codexSourceHome === 'string' ? metadata.codexSourceHome : undefined,
            nativeMultiAgent: metadata?.nativeMultiAgent === true,
            readOnly: metadata?.codexPermissions === 'read-only',
            startupSkills: Array.isArray(metadata?.startupSkills) ? metadata.startupSkills.filter((s): s is string => typeof s === 'string') : undefined,
          };
        })
        .catch((error) => { this.frozen.delete(sessionId); throw error; });
      this.frozen.set(sessionId, directive);
    }
    return directive;
  }

  async get(sessionId?: string): Promise<string | undefined> {
    return (await this.selection(sessionId)).directive;
  }

  async skipsDefaults(sessionId?: string): Promise<boolean> {
    return (await this.selection(sessionId)).skipDefaultInstructions;
  }
}
