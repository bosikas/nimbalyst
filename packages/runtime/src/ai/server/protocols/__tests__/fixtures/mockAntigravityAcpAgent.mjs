import { createInterface } from 'node:readline';

const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

let signedIn = false;
let loaded = false;
let mode = 'auto';
let model = 'flash';
let effort = 'low';
let pending;

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
  } else if (method === 'session/cancel' && pending) {
    finish(pending.id, 'cancelled');
    pending = undefined;
  } else if (!method && id === 'permission-1' && pending) {
    const { sessionId } = pending;
    update(sessionId, 'agent_message_chunk', { content: { type: 'text', text: result.outcome.optionId } });
    finish(pending.id, 'end_turn');
    pending = undefined;
  } else if (id !== undefined) {
    fail(id, -32601, 'Method not found');
  }
}
