// @vitest-environment node
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTIGRAVITY_AUTH_MESSAGE, AntigravityACPProtocol,
} from '../AntigravityACPProtocol';
import type { ProtocolEvent } from '../ProtocolInterface';

const fixture = fileURLToPath(new URL('./fixtures/mockAntigravityAcpAgent.mjs', import.meta.url));
const options = { workspacePath: process.cwd(), mcpServers: {} };
const protocols: AntigravityACPProtocol[] = [];

function createProtocol(apiKey?: string) {
  const permission = vi.fn(async () => ({ decision: 'allow', scope: 'once' } as const));
  const protocol = new AntigravityACPProtocol({
    command: process.execPath, args: [fixture], onPermissionRequest: permission,
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
});
