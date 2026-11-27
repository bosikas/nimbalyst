/**
 * After a completed turn, derive a title from the first user prompt when the
 * session still lacks an assigned name. This requires no model request.
 */

const MAX_TITLE_CHARS = 48;
const MAX_TITLE_WORDS = 8;

/**
 * Derive a session title from the user's first prompt. Null when the prompt
 * isn't usable as a topic (empty, a /slash command, a # memory note).
 */
export function deriveSessionTitleFromPrompt(rawPrompt: string | null | undefined): string | null {
  const prompt = (rawPrompt ?? '').replace(/<NIMBALYST_SYSTEM_MESSAGE>[\s\S]*?<\/NIMBALYST_SYSTEM_MESSAGE>/g, '').trim();
  if (!prompt) return null;
  if (prompt.startsWith('/') || prompt.startsWith('#')) return null;

  const flattened = prompt.replace(/\s+/g, ' ').trim();
  const words = flattened.split(' ');
  let truncated = words.length > MAX_TITLE_WORDS;
  let title = words.slice(0, MAX_TITLE_WORDS).join(' ');
  if (title.length > MAX_TITLE_CHARS) {
    title = title.slice(0, MAX_TITLE_CHARS).replace(/\s+\S*$/, '');
    truncated = true;
  }
  title = title.replace(/[.,;:!?]+$/, '').trim();
  if (title.length < 3) return null;

  return truncated ? `${title}…` : title;
}

export type AutoNameOutcome = 'named' | 'already-named' | 'no-usable-prompt';

export interface AutoNameDeps {
  /** Whether the session already carries an agent/user-chosen name. */
  isAlreadyNamed: (sessionId: string) => Promise<boolean>;
  /** The CLEAN text of the session's first user prompt (null when none). */
  getFirstUserPrompt: (sessionId: string) => Promise<string | null>;
  /** Write the title through the naming pipeline (broadcast + propagation). */
  applyTitle: (sessionId: string, title: string) => Promise<void>;
}

export async function maybeAutoNameSession(
  sessionId: string,
  deps: AutoNameDeps,
): Promise<AutoNameOutcome> {
  if (await deps.isAlreadyNamed(sessionId)) {
    return 'already-named';
  }
  const title = deriveSessionTitleFromPrompt(await deps.getFirstUserPrompt(sessionId));
  if (!title) {
    return 'no-usable-prompt';
  }
  await deps.applyTitle(sessionId, title);
  return 'named';
}
