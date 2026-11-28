import type { QuestionInfo, QuestionRequest } from '@opencode-ai/sdk/v2/client';
import { parseQuestionAnswerArray, type AskUserQuestionPrompt } from '../shared/askUserQuestionTypes';

export interface OpenCodeQuestionAnswer {
  answers?: Record<string, string>;
  respondedBy?: 'desktop' | 'mobile';
}

export interface OpenCodeQuestionHost {
  ask(request: QuestionRequest, signal: AbortSignal): Promise<OpenCodeQuestionAnswer>;
  settle(requestId: string, result: OpenCodeQuestionAnswer): void;
}

export function toAskUserQuestions(questions: QuestionInfo[]): AskUserQuestionPrompt[] {
  return questions.map(({ question, header, options, multiple, custom }) => ({
    question,
    header,
    options,
    multiSelect: multiple === true,
    allowOther: custom !== false,
    answerFormat: 'json-array',
  }));
}

export function toNativeQuestionAnswers(
  questions: QuestionInfo[],
  answers: Record<string, string>,
): string[][] {
  return questions.map(({ question, multiple, options, custom }) => {
    const value = Object.hasOwn(answers, question) ? answers[question] : undefined;
    const selections = parseQuestionAnswerArray(value);
    if (!selections?.length || (!multiple && selections.length > 1) ||
        (custom === false && selections.some((selection) => !options.some(({ label }) => label === selection)))) {
      throw new Error('Invalid OpenCode question answer');
    }
    return selections;
  });
}
