// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { spawn, type SpawnOptions } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_AUTH_MESSAGE, AntigravityACPProtocol,
} from '../AntigravityACPProtocol';
import type { MCPServerConfig, ProtocolEvent } from '../ProtocolInterface';
import type { AcpFormElicitationHandler } from '../GrokACPProtocol';

const fixture = fileURLToPath(new URL('./fixtures/mockAntigravityAcpAgent.mjs', import.meta.url));
const options = { workspacePath: process.cwd(), mcpServers: {} };
const protocols: AntigravityACPProtocol[] = [];

function createProtocol(apiKey?: string, onFormElicitation?: AcpFormElicitationHandler) {
  const permission = vi.fn(async () => ({ decision: 'allow', scope: 'once' } as const));
  const protocol = new AntigravityACPProtocol({
    command: process.execPath, args: [fixture], onPermissionRequest: permission, onFormElicitation,
  });
  protocol.setApiKey(apiKey);
  protocols.push(protocol);
  return { protocol, permission };
}

afterEach(() => {
  for (const protocol of protocols.splice(0)) protocol.destroy();
  vi.unstubAllEnvs();
});

describe('Google Antigravity CLI ACP', () => {
  it('uses the settings key and negotiates effort choices per model', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'unrelated-shell-key');
    vi.stubEnv('GOOGLE_OAUTH_ACCESS_TOKEN', 'unrelated-shell-token');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://unrelated.example');
    const { protocol } = createProtocol('fixture-key');

    await expect(protocol.discoverModels(options.workspacePath)).resolves.toEqual([
      expect.objectContaining({ id: 'antigravity-acp:default', effortLevels: ['low', 'high'] }),
      expect.objectContaining({ id: 'antigravity-acp:flash', effortLevels: ['low', 'high'] }),
      expect.objectContaining({ id: 'antigravity-acp:pro', effortLevels: ['low', 'xhigh', 'max'] }),
    ]);
  });

  it('requires the configured key and reports a rejected authentication', async () => {
    vi.stubEnv('GEMINI_API_KEY', 'fixture-key');
    await expect(createProtocol().protocol.createSession(options)).rejects.toThrow(ANTIGRAVITY_AUTH_MESSAGE);
    await expect(createProtocol('wrong-key').protocol.createSession(options)).rejects.toThrow(ANTIGRAVITY_AUTH_MESSAGE);
  });

  it('streams output, asks permission and resumes the native session in a new process', async () => {
    const { protocol } = createProtocol('fixture-key');
    const original = await protocol.createSession(options);
    protocol.destroy();

    const { protocol: restarted, permission } = createProtocol('fixture-key');
    const resumed = await restarted.resumeSession(original.id, {
      ...options, model: 'antigravity-acp:pro', raw: { effortLevel: 'xhigh' },
    });
    const events = await Array.fromAsync(restarted.sendMessage(resumed, { content: 'continue' }));

    expect(resumed.id).toBe(original.id);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', content: 'loaded pro extra' }),
      expect.objectContaining({ type: 'text', content: 'allow' }),
      expect.objectContaining({ usage: expect.objectContaining({ input_tokens: 32, total_tokens: 50 }) }),
    ]));
    expect(permission).toHaveBeenCalledOnce();
    await expect(restarted.resumeSession('missing', options)).rejects.toThrow('Unknown fixture session');
    await expect(restarted.resumeSession(original.id, { ...options, model: 'antigravity-acp:removed' }))
      .rejects.toThrow('did not offer model "removed"');
  });

  it('cancels an active turn through ACP', async () => {
    const { protocol } = createProtocol('fixture-key');
    const session = await protocol.createSession(options);
    const cancellation = new AbortController();
    const events: ProtocolEvent[] = [];

    for await (const event of protocol.sendMessage(session, { content: 'cancel fixture turn', abortSignal: cancellation.signal })) {
      events.push(event);
      if (event.type === 'text') cancellation.abort();
    }

    expect(events).toContainEqual(expect.objectContaining({ type: 'text', content: 'waiting' }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'complete', metadata: { stopReason: 'cancelled' },
    }));
  });

  it.each([
    ['ask fixture form', { action: 'accept', content: { release: 'stable' } }],
    ['ask fixture request form', { action: 'decline' }],
  ] as const)('returns the elicitation response for %s', async (content, response) => {
    const handler = vi.fn<AcpFormElicitationHandler>().mockResolvedValue(response);
    const { protocol } = createProtocol('fixture-key', handler);
    const session = await protocol.createSession(options);
    const events = await Array.fromAsync(protocol.sendMessage(session, { content, sessionId: 'local-session' }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', content: JSON.stringify(response) }));
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'form', message: 'Choose a release' }),
      expect.objectContaining({ sessionId: 'local-session', workspacePath: options.workspacePath }),
    );
  });

  it('cancels an unanswered elicitation when the turn is cancelled', async () => {
    const turn = new AbortController();
    const ready = Promise.withResolvers<void>();
    const handler = vi.fn<AcpFormElicitationHandler>().mockImplementation(async (_request, { signal }) => {
      const cancelled = new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      ready.resolve();
      await cancelled;
      return { action: 'decline' };
    });
    const { protocol } = createProtocol('fixture-key', handler);
    const session = await protocol.createSession(options);
    const running = Array.fromAsync(protocol.sendMessage(session, {
      content: 'ask fixture form', sessionId: 'local-session', abortSignal: turn.signal,
    }));
    await ready.promise;
    turn.abort();
    expect(await running).toContainEqual(expect.objectContaining({
      type: 'text', content: '{"action":"cancel"}',
    }));
  });

  it('cancels elicitation tied to a different request without showing a form', async () => {
    const handler = vi.fn<AcpFormElicitationHandler>();
    const { protocol } = createProtocol('fixture-key', handler);
    const session = await protocol.createSession(options);
    const events = await Array.fromAsync(protocol.sendMessage(session, {
      content: 'ask fixture stale form', sessionId: 'local-session',
    }));
    expect(events).toContainEqual(expect.objectContaining({ type: 'text', content: '{"action":"cancel"}' }));
    expect(handler).not.toHaveBeenCalled();
  });

  it('launches its HTTP MCP worker and sends the Aifredas Playwright connection', async () => {
    const launch = vi.fn((_command: string, args: string[], spawnOptions: SpawnOptions) =>
      spawn(process.execPath, [fixture, 'check-mcp', ...args], spawnOptions));
    const protocol = new AntigravityACPProtocol({ spawnProcess: launch as unknown as typeof spawn });
    protocol.setApiKey('fixture-key');
    protocols.push(protocol);
    await expect(protocol.createSession({
      ...options,
      mcpServers: {
        playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.82', '--headless', '--isolated'] },
        'aifredas-http': { type: 'http', url: 'http://127.0.0.1:4040/mcp' } as unknown as MCPServerConfig,
      },
    })).resolves.toMatchObject({ deliveredMcpServerCount: 2 });
    expect(launch).toHaveBeenCalledWith(expect.stringMatching(/agy/), ['acp', '--process-per-session'], expect.anything());
  });
});
