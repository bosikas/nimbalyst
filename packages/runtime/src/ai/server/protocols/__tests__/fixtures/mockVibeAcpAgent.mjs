import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const input = createInterface({ input: process.stdin });
const write = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...body }) + '\n');
const sessionId = 'vibe-session';
const permissionsId = 'permission-1';
let mode = 'accept-edits';
let model = 'mistral-medium';
let thinking = 'high';
let runningPrompt;

const effortByModel = {
  'mistral-medium': ['off', 'high'],
  'deepseek': ['off', 'low', 'high', 'max'],
};
const configuration = () => [
  { id: 'mode', type: 'select', category: 'mode', name: 'Mode', currentValue: mode, options: [
    { value: 'ask', name: 'Ask' }, { value: 'accept-edits', name: 'Accept edits' },
  ] },
  { id: 'model', type: 'select', category: 'model', name: 'Model', currentValue: model, options: [
    { value: 'mistral-medium', name: 'Mistral Medium' },
    { group: 'hosted', name: 'Mistral Hosted', options: [{ value: 'deepseek', name: 'DeepSeek' }] },
  ] },
  { id: 'thinking', type: 'select', category: 'thought_level', name: 'Thinking', currentValue: thinking,
    options: effortByModel[model].map((value) => ({ value, name: value })) },
];
const update = (body) => write({ method: 'session/update', params: { sessionId, update: body } });

for await (const line of input) {
  const { id, method, params, result } = JSON.parse(line);
  switch (method) {
    case '_account/read':
      write({ id, result: params.sessionId === sessionId ? {
        budget: { usage_percentage: 23.4, reset_at: '2027-01-01T00:00:00Z' },
        api_key: { has_key: true },
      } : {} });
      break;
    case '_trust/status': {
      appendFileSync(process.env.VIBE_TRUST_LOG, JSON.stringify([method, params]) + '\n');
      if (process.env.VIBE_TRUST_CASE === 'older-cli') {
        write({ id, error: { code: -32601, message: 'Method not found' } });
        break;
      }
      const result = params.cwd !== process.env.VIBE_TRUST_PRIMARY
        ? { trust_status: 'untrusted', details: { cwd: params.cwd, repoExplicitlyUntrusted: process.env.VIBE_TRUST_CASE === 'declined', availableDecisions: ['trust_cwd'] } }
        : { trust_status: process.env.VIBE_TRUST_CASE === 'untrusted-source' ? 'untrusted' : 'trusted' };
      write({ id, result });
      break;
    }
    case '_trust/decision':
      appendFileSync(process.env.VIBE_TRUST_LOG, JSON.stringify([method, params]) + '\n');
      mode = 'accept-edits';
      write({ id, result: { trust_status: 'trusted' } });
      break;
    case 'initialize':
      write({ id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true }, authMethods: [] } });
      break;
    case 'session/new':
    case 'session/load': {
      const servers = params.mcpServers ?? [];
      if (process.env.VIBE_TRUST_LOG) {
        appendFileSync(process.env.VIBE_TRUST_LOG, JSON.stringify([method, { cwd: params.cwd, hasServers: servers.length > 0 }]) + '\n');
      }
      const host = servers.find((server) => server.name === 'nimbalyst');
      if (servers.length && (host?.type !== 'http' || host.url !== 'http://localhost:7000/mcp/core'
        || !host.headers?.some(({ name, value }) => name === 'Authorization' && value === 'Bearer test-token'))) {
        write({ id, error: { code: -32602, message: 'Missing workspace MCP server' } });
        break;
      }
      write({ id, result: { sessionId, configOptions: configuration() } });
      break;
    }
    case 'session/set_config_option':
      if (process.env.VIBE_TRUST_LOG && params.configId === 'mode') {
        appendFileSync(process.env.VIBE_TRUST_LOG, JSON.stringify([method, params]) + '\n');
      }
      if (params.configId === 'mode') mode = params.value;
      if (params.configId === 'model') {
        model = params.value;
        thinking = 'high';
      }
      if (params.configId === 'thinking') {
        if (!effortByModel[model].includes(params.value)) {
          write({ id, error: { code: -32602, message: 'Unsupported thinking effort' } });
          break;
        }
        thinking = params.value;
      }
      write({ id, result: { configOptions: configuration() } });
      break;
    case 'session/prompt': {
      if (mode !== 'ask') {
        write({ id, error: { code: -32602, message: 'Expected Ask mode' } });
        break;
      }
      const text = params.prompt.filter(block => block.type === 'text').map(block => block.text).join('\n');
      if (text === '/report-config') {
        update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `${model}:${thinking}` } });
        write({ id, result: { stopReason: 'end_turn' } });
        break;
      }
      if (text === '/compact') {
        update({ sessionUpdate: 'tool_call_update', toolCallId: 'compact', title: 'Compacted conversation history', status: 'completed' });
        write({ id, result: { stopReason: 'end_turn' } });
        break;
      }
      if (!params.prompt.some((block) => block.type === 'image' && block.data)) {
        write({ id, error: { code: -32602, message: 'Expected an image attachment' } });
        break;
      }
      runningPrompt = id;
      write({
        id: permissionsId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: { toolCallId: 'edit', kind: 'edit', title: 'Edit a.txt', rawInput: { file_path: 'a.txt' } },
          options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow once' }],
        },
      });
      break;
    }
    case '_nimbalyst/steer':
      if (!process.env.VIBE_STEERING) {
        write({ id, error: { code: -32601, message: 'Method not found' } });
        break;
      }
      if (!runningPrompt || params.sessionId !== sessionId || params.messageId !== 'queued-id') {
        write({ id, result: { accepted: false } });
        break;
      }
      update({ sessionUpdate: 'agent_message_chunk', content: params.prompt[0] });
      write({ id, result: { accepted: true } });
      break;
    default:
      if (id !== permissionsId) break;
      if (result?.outcome?.optionId !== 'allow') {
        write({ id: runningPrompt, error: { code: -32602, message: 'Permission was not delegated to the host' } });
        break;
      }
      update({ sessionUpdate: 'tool_call', toolCallId: 'edit', kind: 'edit', title: 'Edit a.txt', rawInput: { file_path: 'a.txt' } });
      update({ sessionUpdate: 'tool_call_update', toolCallId: 'edit', status: 'completed', content: [
        { type: 'diff', path: 'a.txt', oldText: 'one', newText: 'two' },
      ] });
      update({ sessionUpdate: 'usage_update', used: 150, size: 256000 });
      update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done.' } });
      write({ id: runningPrompt, result: {
        stopReason: 'end_turn', usage: { inputTokens: 230, cachedReadTokens: 130, outputTokens: 10, totalTokens: 240 },
      } });
  }
}
