let loader: (() => string | undefined) | undefined;

/** The desktop host reads the selected Markdown file; native defaults remain the fallback. */
export function setCodexBaseInstructionsLoader(value?: () => string | undefined): void {
  loader = value;
}

/** Call only when creating a native thread. Resumes retain their original instructions. */
export function loadCodexBaseInstructions(): string | undefined {
  const text = loader?.();
  if (text !== undefined && (typeof text !== 'string' || !text.trim())) {
    throw new Error('The selected Codex base instruction file is empty or invalid.');
  }
  return text;
}

export function resolveCodexBaseInstructions(options: {
  hasLiveSession: boolean;
  persistedThreadId?: string | null;
  transport: 'app-server' | 'sdk';
}): string | undefined {
  if (options.hasLiveSession || options.persistedThreadId) return undefined;
  const text = loadCodexBaseInstructions();
  if (text !== undefined && options.transport !== 'app-server') {
    throw new Error('Custom Codex base instructions require the app-server transport.');
  }
  return text;
}
