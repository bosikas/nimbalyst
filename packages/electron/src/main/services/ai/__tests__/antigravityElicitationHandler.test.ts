// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AcpFormElicitationHandler } from '@nimbalyst/runtime/ai/server/protocols/GrokACPProtocol';
import { prepareAntigravityElicitation, presentAntigravityElicitation } from '../antigravityElicitationHandler';

const { runForm, logQuestion, logResult } = vi.hoisted(() => ({
  runForm: vi.fn(),
  logQuestion: vi.fn(),
  logResult: vi.fn(),
}));
vi.mock('../../../mcp/tools/interactiveToolHandlers', () => ({ handleRequestUserInput: runForm }));
vi.mock('../../../mcp/tools/interactivePromptTranscript', () => ({
  persistInteractivePromptToolUse: logQuestion,
  persistInteractivePromptToolResult: logResult,
}));

const request: Parameters<AcpFormElicitationHandler>[0] = {
  mode: 'form', sessionId: 'native-session', message: 'Choose a release.',
  requestedSchema: {
    type: 'object',
    properties: {
      release: { type: 'string', oneOf: [{ const: 'stable', title: 'Stable' }] },
      retries: { type: 'integer', minimum: 1, maximum: 3 },
      enabled: { type: 'boolean' },
      targets: { type: 'array', items: { type: 'string', enum: ['desktop', 'browser'] } },
    },
    required: ['release', 'enabled'],
  },
};

const answers = {
  release: { type: 'singleSelect', selectedId: 'stable' },
  retries: { type: 'editText', text: '2', edited: true },
  enabled: { type: 'singleSelect', selectedId: 'false' },
  targets: { type: 'multiSelect', selectedIds: ['browser'] },
};

beforeEach(() => vi.resetAllMocks());

describe('Antigravity elicitation presentation', () => {
  it('maps the typed form and validates the answers before forwarding them', () => {
    const form = prepareAntigravityElicitation(request)!;
    expect(form.fields.map(({ type }) => type)).toEqual(['singleSelect', 'editText', 'singleSelect', 'multiSelect']);
    expect(form.respond(answers)).toEqual({
      action: 'accept', content: { release: 'stable', retries: 2, enabled: false, targets: ['browser'] },
    });
    expect(form.respond({ ...answers, retries: { type: 'editText', text: '4' } })).toEqual({ action: 'decline' });
    expect(form.respond({ ...answers, enabled: undefined })).toEqual({ action: 'decline' });
  });

  it('publishes the durable form under the same ID used by desktop and browser answers', async () => {
    const signal = new AbortController().signal;
    runForm.mockResolvedValue({ content: [{ type: 'text', text: JSON.stringify({ answers }) }] });
    await expect(presentAntigravityElicitation(request, { sessionId: 'local', workspacePath: '/workspace', signal }))
      .resolves.toMatchObject({ action: 'accept' });
    const [published] = logQuestion.mock.calls[0];
    expect(published).toMatchObject({ sessionId: 'local', source: 'antigravity-acp', toolName: 'PromptForUserInput' });
    expect(runForm).toHaveBeenCalledWith(published.input, 'local', '/workspace', { id: published.toolUseId }, { signal });
  });

  it('settles the durable form when the ACP turn aborts', async () => {
    const controller = new AbortController();
    runForm.mockImplementation(async () => {
      controller.abort();
      return { isError: true, content: [] };
    });
    await expect(presentAntigravityElicitation(request, {
      sessionId: 'local', workspacePath: '/workspace', signal: controller.signal,
    })).resolves.toEqual({ action: 'cancel' });
    expect(logResult).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'local', source: 'antigravity-acp', result: { cancelled: true, answers: {} },
    }));
  });

  it('maps a dismissal through the shared response path to ACP cancel', async () => {
    runForm.mockResolvedValue({ isError: true, content: [{ type: 'text', text: '{"cancelled":true}' }] });
    await expect(presentAntigravityElicitation(request, {
      sessionId: 'local', workspacePath: '/workspace', signal: new AbortController().signal,
    })).resolves.toEqual({ action: 'cancel' });
    expect(logResult).not.toHaveBeenCalled();
  });
});
