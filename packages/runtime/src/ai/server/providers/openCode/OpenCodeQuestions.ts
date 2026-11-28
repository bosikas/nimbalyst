import type { QuestionInfo, QuestionRequest } from '@opencode-ai/sdk/v2/client';

export interface OpenCodeQuestionAnswer {
  answers?: Record<string, string>;
  respondedBy?: 'desktop' | 'mobile';
}

export interface OpenCodeQuestionHost {
  ask(request: QuestionRequest, signal: AbortSignal): Promise<OpenCodeQuestionAnswer>;
  settle(requestId: string, result: OpenCodeQuestionAnswer): void;
}

export function toAskUserQuestions(questions: QuestionInfo[]) {
  return questions.map(({ question, header, options, multiple }) => ({
    question,
    header,
    options,
    multiSelect: multiple === true,
  }));
}

export function toNativeQuestionAnswers(
  questions: QuestionInfo[],
  answers: Record<string, string>,
): string[][] {
  return questions.map(({ question, multiple, options }) => {
    const value = Object.hasOwn(answers, question) ? answers[question] : undefined;
    if (!value) return [];
    if (!multiple) return [value];

    // The AskUserQuestion widget joins selected labels with ", " and appends
    // any custom text last. Match complete labels before preserving that text.
    const labels = options.map(({ label }) => label).filter(Boolean).sort((a, b) => b.length - a.length);
    const selected: string[] = [];
    let remaining = value;
    while (remaining) {
      const label = labels.find((option) => remaining === option || remaining.startsWith(option + ', '));
      if (!label) {
        selected.push(remaining);
        break;
      }
      selected.push(label);
      remaining = remaining.slice(label.length + 2);
    }
    return selected;
  });
}
