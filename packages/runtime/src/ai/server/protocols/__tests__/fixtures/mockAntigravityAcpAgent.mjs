import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

let signedIn = false;
let loaded = false;
let mode = 'auto';
let model = 'flash';
let effort = 'low';
let pending;
let form;
let formSupported = false;

function configOptions() {
  const select = (id, category, currentValue, options) => ({
    id, category, type: 'select', name: id, currentValue,
    options: options.map(([value, name]) => ({ value, name })),
  });
  return [
    select('agent-mode', 'mode', mode, [['default', 'Default'], ['auto', 'Auto']]),
    select('google-model', 'model', model, [['flash', 'Fixture Flash'], ['pro', 'Fixture Pro']]),
    select('google-thinking', 'thought_level', effort, model === 'flash'
      ? [['low', 'Low'], ['high', 'High']]
      : [['low', 'Low'], ['extra', 'Extra'], ['max', 'Max']]),
  ];
}

const toolCall = {
  toolCallId: 'edit-1', title: 'Edit fixture.txt', kind: 'edit', status: 'pending',
};
const update = (sessionId, sessionUpdate, data) => send({
  method: 'session/update', params: { sessionId, update: { sessionUpdate, ...data } },
});
const finish = (id, stopReason) => reply(id, {
  stopReason, usage: { inputTokens: 42, cachedReadTokens: 10, outputTokens: 8, totalTokens: 50 },
});

for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params, result } = JSON.parse(line);
  if (method === 'initialize') {
    formSupported = !!params.clientCapabilities?.elicitation?.form && !params.clientCapabilities?.elicitation?.url;
    reply(id, {
      protocolVersion: 1,
      agentCapabilities: { loadSession: true },
      authMethods: [{ id: 'gemini-api-key', name: 'Gemini API key' }],
    });
  } else if (method === 'authenticate') {
    signedIn = params.methodId === 'gemini-api-key' && process.env.GEMINI_API_KEY === 'fixture-key'
      && !process.env.GOOGLE_OAUTH_ACCESS_TOKEN && !process.env.GOOGLE_GEMINI_BASE_URL;
    if (signedIn) reply(id, {});
    else fail(id, -32000, 'Authentication required');
  } else if (method?.startsWith('session/') && !signedIn) {
    fail(id, -32000, 'Authentication required');
  } else if (method === 'session/new') {
    if (process.argv.includes('check-mcp')) {
      const expected = [
        {
          name: 'playwright', command: 'npx',
          args: ['-y', '@playwright/mcp@0.0.82', '--headless', '--isolated'], env: [],
        },
        { type: 'http', name: 'aifredas-http', url: 'http://127.0.0.1:4040/mcp', headers: [] },
      ];
      if (!process.argv.includes('--process-per-session')
        || !isDeepStrictEqual(params.mcpServers, expected)) {
        fail(id, -32602, 'Incorrect Aifredas MCP connection payload or ACP launch flags');
        continue;
      }
    }
    reply(id, { sessionId: 'agy-fixture-session', configOptions: configOptions() });
  } else if (method === 'session/resume') {
    if (params.sessionId !== 'agy-fixture-session') {
      fail(id, -32602, 'Unknown fixture session');
      continue;
    }
    loaded = true;
    reply(id, { configOptions: configOptions() });
  } else if (method === 'session/set_config_option') {
    if (params.configId === 'agent-mode') mode = params.value;
    if (params.configId === 'google-model') model = params.value;
    if (params.configId === 'google-thinking') effort = params.value;
    reply(id, { configOptions: configOptions() });
  } else if (method === 'session/prompt') {
    const { sessionId, prompt } = params;
    if (mode !== 'default') {
      fail(id, -32602, 'Approval mode was not configured');
      continue;
    }
    const text = prompt.find((block) => block.type === 'text')?.text;
    if (['ask fixture form', 'ask fixture request form', 'ask fixture stale form'].includes(text)) {
      if (!formSupported) {
        fail(id, -32602, 'Client did not advertise form elicitation');
        continue;
      }
      form = { id, sessionId, cancelled: false };
      send({
        id: 'fixture-form', method: 'elicitation/create',
        params: {
          mode: 'form', message: 'Choose a release',
          ...(text === 'ask fixture form' ? { sessionId } : {
            requestId: text === 'ask fixture stale form' ? 'retired-request' : id,
          }),
          requestedSchema: { type: 'object', properties: { release: { type: 'string', enum: ['stable', 'beta'] } }, required: ['release'] },
        },
      });
      continue;
    }
    if (prompt.some((block) => block.type === 'text' && block.text.includes('cancel fixture turn'))) {
      pending = { id, sessionId };
      update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: 'waiting' } });
      continue;
    }
    update(sessionId, 'agent_thought_chunk', { content: { type: 'text', text: 'Thinking' } });
    update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: `${loaded ? 'loaded' : 'new'} ${model} ${effort}` } });
    pending = { id, sessionId };
    send({
      id: 'permission-1',
      method: 'session/request_permission',
      params: {
        sessionId, toolCall, options: [
          { optionId: 'allow', kind: 'allow_once', name: 'Allow once' },
          { optionId: 'deny', kind: 'reject_once', name: 'Deny' },
        ],
      },
    });
  } else if (method === 'session/cancel' && form) {
    form.cancelled = true;
  } else if (method === 'session/cancel' && pending) {
    finish(pending.id, 'cancelled');
    pending = undefined;
  } else if (!method && id === 'fixture-form' && form) {
    if (!result) {
      fail(form.id, -32602, 'Client did not answer the form');
    } else {
      update(form.sessionId, 'agent_message_chunk', { content: { type: 'text', text: JSON.stringify(result) } });
      finish(form.id, form.cancelled ? 'cancelled' : 'end_turn');
    }
    form = undefined;
  } else if (!method && id === 'permission-1' && pending) {
    const { sessionId } = pending;
    update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: result.outcome.optionId } });
    finish(pending.id, 'end_turn');
    pending = undefined;
  } else if (id !== undefined) {
    fail(id, -32601, 'Method not found');
  }
}
