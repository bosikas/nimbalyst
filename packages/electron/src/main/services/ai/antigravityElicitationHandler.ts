import { randomUUID } from 'node:crypto';
import type { AcpFormElicitationHandler } from '@nimbalyst/runtime/ai/server/protocols/GrokACPProtocol';
import type {
  RequestUserInputField,
} from '@nimbalyst/runtime/ai/server/providers/shared/requestUserInputTypes';
import { handleRequestUserInput } from '../../mcp/tools/interactiveToolHandlers';
import {
  persistInteractivePromptToolResult,
  persistInteractivePromptToolUse,
} from '../../mcp/tools/interactivePromptTranscript';

type FormRequest = Parameters<AcpFormElicitationHandler>[0];
type FormResponse = Awaited<ReturnType<AcpFormElicitationHandler>>;
type Property = NonNullable<FormRequest['requestedSchema']['properties']>[string];
type Value = string | number | boolean | string[];
type PromptResult = { cancelled?: boolean; answers?: Record<string, unknown> };
const PROVIDER = 'antigravity-acp';
const TOOL_NAME = 'PromptForUserInput';

function fieldFor(id: string, property: Property, required: boolean): RequestUserInputField | undefined {
  const base = {
    id, label: property.title || id,
    description: [property.description, required ? 'Required.' : undefined].filter(Boolean).join(' ') || undefined,
  };
  if (property.type === 'array') {
    const items = 'anyOf' in property.items
      ? property.items.anyOf.map((item) => ({ id: item.const, title: item.title }))
      : property.items.enum.map((value) => ({ id: value, title: value }));
    if (!items.length) return undefined;
    return {
      ...base, type: 'multiSelect',
      items: items.map((item) => ({ ...item, defaultChecked: property.default?.includes(item.id) })),
      minSelected: property.minItems ?? undefined,
      maxSelected: property.maxItems ?? undefined,
    };
  }
  const options = property.type === 'boolean' ? [
    { id: 'true', label: 'Yes' }, { id: 'false', label: 'No' },
  ] : property.type === 'string' ? (
    property.oneOf?.map((item) => ({ id: item.const, label: item.title }))
      ?? property.enum?.map((value) => ({ id: value, label: value }))
  ) : undefined;
  if (options) return options.length ? { ...base, type: 'singleSelect', options } : undefined;
  if (property.type === 'string' && (property.format || property.pattern)) return undefined;
  return {
    ...base, type: 'editText', format: 'plain',
    initialText: property.default == null ? '' : String(property.default),
  };
}

function readValue(property: Property, field: RequestUserInputField, answer: unknown): Value | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const value = answer as Record<string, unknown>;
  if (value.type !== field.type) return undefined;
  if (field.type === 'singleSelect' && typeof value.selectedId === 'string') {
    if (!field.options.some(({ id }) => id === value.selectedId)) return undefined;
    return property.type === 'boolean' ? value.selectedId === 'true' : value.selectedId;
  }
  if (field.type === 'multiSelect' && Array.isArray(value.selectedIds)) {
    const selection = value.selectedIds;
    if (selection.length < (field.minSelected ?? 0) || selection.length > (field.maxSelected ?? field.items.length)
      || selection.length !== new Set(selection).size || !selection.every((id) => field.items.some((item) => item.id === id))) {
      return undefined;
    }
    return selection;
  }
  if (field.type !== 'editText' || typeof value.text !== 'string') return undefined;
  if (property.type === 'string') {
    const length = Array.from(value.text).length;
    return length >= (property.minLength ?? 0) && length <= (property.maxLength ?? Infinity)
      ? value.text : undefined;
  }
  if ((property.type === 'number' || property.type === 'integer') && value.text.trim()) {
    const number = Number(value.text);
    if (Number.isFinite(number) && (property.type !== 'integer' || Number.isInteger(number))
      && number >= (property.minimum ?? -Infinity) && number <= (property.maximum ?? Infinity)) return number;
  }
  return undefined;
}

export function prepareAntigravityElicitation(request: FormRequest) {
  const properties = request.requestedSchema.properties ?? {};
  const required = new Set(request.requestedSchema.required ?? []);
  const fields: RequestUserInputField[] = [];
  for (const [id, property] of Object.entries(properties)) {
    const field = fieldFor(id, property, required.has(id));
    if (!field) return undefined;
    fields.push(field);
  }
  if (fields.length === 0) {
    fields.push({ id: 'confirm', type: 'confirm', label: request.message });
    return {
      fields,
      respond: (answers: Record<string, unknown>): FormResponse =>
        (answers.confirm as { value?: boolean } | undefined)?.value === true
          ? { action: 'accept', content: {} } : { action: 'decline' },
    };
  }
  fields[0] = { ...fields[0], description: [request.message, fields[0].description].filter(Boolean).join('\n') };
  return {
    fields,
    respond: (answers: Record<string, unknown>): FormResponse => {
      const entries: Array<[string, Value]> = [];
      for (const field of fields) {
        const answer = Object.hasOwn(answers, field.id) ? answers[field.id] : undefined;
        const value = readValue(properties[field.id], field, answer);
        if (value !== undefined) entries.push([field.id, value]);
        else if (required.has(field.id) || answer !== undefined) return { action: 'decline' };
      }
      return { action: 'accept', content: Object.fromEntries(entries) };
    },
  };
}

export const presentAntigravityElicitation: AcpFormElicitationHandler = async (request, context) => {
  const form = prepareAntigravityElicitation(request);
  if (!form) return { action: 'decline' };
  const { sessionId, workspacePath, signal } = context;
  const promptId = `acp-elicitation-${randomUUID()}`;
  const input = { fields: form.fields };
  await persistInteractivePromptToolUse({
    sessionId, toolUseId: promptId, toolName: TOOL_NAME, input, source: PROVIDER,
  });
  const result = await handleRequestUserInput(input, sessionId, workspacePath, { id: promptId }, { signal });
  if (signal.aborted && result.isError) {
    await persistInteractivePromptToolResult({
      sessionId, toolUseId: promptId, result: { cancelled: true, answers: {} }, isError: true, source: PROVIDER,
    });
    return { action: 'cancel' };
  }
  const text = result.content.find((item) => item.type === 'text');
  const response = text?.type === 'text' && text.text.startsWith('{') ? JSON.parse(text.text) as PromptResult : {};
  if (response.cancelled) return { action: 'cancel' };
  if (result.isError) return { action: 'decline' };
  return form.respond(response.answers ?? {});
};
