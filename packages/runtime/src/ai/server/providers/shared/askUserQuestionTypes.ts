export interface AskUserQuestionPromptOption {
  label: string;
  description: string;
}

export interface AskUserQuestionPrompt {
  question: string;
  header: string;
  options: AskUserQuestionPromptOption[];
  multiSelect: boolean;
  allowOther?: boolean;
  answerFormat?: 'json-array';
}

/** The existing question transport carries strings, so preserve native selections as JSON. */
export function parseQuestionAnswerArray(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : undefined;
  } catch {
    return undefined;
  }
}
