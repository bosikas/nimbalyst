// @vitest-environment node

import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MistralVibeACPProtocol } from '../MistralVibeACPProtocol';
import { mapVibeSessionUpdate } from '../headless/MistralVibeRecordMapper';
import type { ProtocolEvent } from '../ProtocolInterface';

const fixture = fileURLToPath(new URL('./fixtures/mockVibeAcpAgent.mjs', import.meta.url));
const options = {
  workspacePath: process.cwd(),
  model: 'mistral-vibe:default',
  mcpServers: {
    nimbalyst: {
      command: '',
      type: 'http' as const,
      url: 'http://localhost:7000/mcp/core',
      headers: { Authorization: 'Bearer test-token' },
    },
    external: { command: 'external-mcp' },
    legacy: { command: '', type: 'sse' as const, url: 'http://localhost:7000/sse' },
  },
  raw: { permissionsPath: '/trusted-workspace' },
};

describe('Mistral Vibe ACP', () => {
  it('reads only the usage and reset date from a live native account', async () => {
    const protocol = new MistralVibeACPProtocol({ command: process.execPath, args: [fixture] });
    try {
      await protocol.createSession(options);
      expect(await MistralVibeACPProtocol.readAccountUsage()).toEqual({
        utilization: 23.4, resetsAt: '2027-01-01T00:00:00Z',
      });
    } finally {
      protocol.destroy();
    }
    expect(await MistralVibeACPProtocol.readAccountUsage()).toBeNull();
  });

  it.each(['grant', 'create', 'declined', 'untrusted-source', 'unrelated', 'older-cli'])(
    'inherits native trust only for an eligible checkout (%s)', async (trustCase) => {
      const root = await realpath(await mkdtemp(path.join(tmpdir(), 'vibe-worktree-trust-')));
      const primary = path.join(root, 'primary');
      const worktree = path.join(root, 'worktree');
      const log = path.join(root, 'trust-log');
      const git = (...args: string[]) => execFileSync('git', args, { stdio: 'ignore' });
      const protocol = new MistralVibeACPProtocol({
        command: process.execPath,
        args: [fixture],
        env: { VIBE_TRUST_CASE: trustCase, VIBE_TRUST_LOG: log, VIBE_TRUST_PRIMARY: primary },
      });
      try {
        git('init', primary);
        git('-C', primary, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--allow-empty', '-m', 'Initial');
        if (trustCase === 'unrelated') git('init', worktree);
        else git('-C', primary, 'worktree', 'add', '--detach', worktree);

        const sessionOptions = {
          ...options, workspacePath: worktree, raw: { permissionsPath: primary },
        };
        if (trustCase === 'create') await protocol.createSession(sessionOptions);
        else await protocol.resumeSession('vibe-session', sessionOptions);

        const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
        const expected = [];
        if (trustCase !== 'unrelated') expected.push(['_trust/status', { cwd: primary }]);
        if (trustCase === 'grant' || trustCase === 'create' || trustCase === 'declined') {
          expected.push(['_trust/status', { cwd: worktree }]);
        }
        if (trustCase === 'grant' || trustCase === 'create') {
          expected.push(['session/new', { cwd: worktree, hasServers: false }]);
          expected.push(['_trust/decision', { sessionId: 'vibe-session', cwd: worktree, decision: 'trust_cwd' }]);
        }
        expected.push([trustCase === 'create' ? 'session/new' : 'session/load', { cwd: worktree, hasServers: true }]);
        expected.push(['session/set_config_option', { sessionId: 'vibe-session', configId: 'mode', value: 'ask' }]);
        expect(calls).toEqual(expected);
      } finally {
        protocol.destroy();
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it('discovers grouped models and the effort options for each model', async () => {
    const protocol = new MistralVibeACPProtocol({ command: process.execPath, args: [fixture] });
    try {
      const models = await protocol.discoverModels(options.workspacePath);
      expect(models).toMatchObject([
        { id: 'mistral-vibe:default', effortLevels: ['high'], supportsThinkingOff: true },
        { id: 'mistral-vibe:mistral-medium', effortLevels: ['high'], supportsThinkingOff: true },
        { id: 'mistral-vibe:deepseek', effortLevels: ['low', 'high', 'max'], supportsThinkingOff: true },
      ]);
    } finally {
      protocol.destroy();
    }
  });

  it('applies effort after changing the model on create and resume', async () => {
    const protocol = new MistralVibeACPProtocol({ command: process.execPath, args: [fixture] });
    try {
      const model = 'mistral-vibe:deepseek';
      const created = await protocol.createSession({ ...options, model, raw: { effortLevel: 'max' } });
      const first: ProtocolEvent[] = [];
      for await (const event of protocol.sendMessage(created, { content: '/report-config' })) first.push(event);
      expect(first).toContainEqual(expect.objectContaining({ type: 'text', content: 'deepseek:max' }));

      const resumed = await protocol.resumeSession(created.id, {
        ...options, model, raw: { effortLevel: 'medium', thinkingMode: 'disabled' },
      });
      const second: ProtocolEvent[] = [];
      for await (const event of protocol.sendMessage(resumed, { content: '/report-config' })) second.push(event);
      expect(second).toContainEqual(expect.objectContaining({ type: 'text', content: 'deepseek:off' }));
    } finally {
      protocol.destroy();
    }
  });

  it('resumes through a new process and streams permission, edits, context and usage', async () => {
    const onPermissionRequest = vi.fn(async () => ({ decision: 'allow', scope: 'once' } as const));
    const createProtocol = () => new MistralVibeACPProtocol({
      command: process.execPath,
      args: [fixture],
      onPermissionRequest,
    });
    const first = createProtocol();
    let sessionId: string;
    try {
      const session = await first.createSession(options);
      expect(session).toMatchObject({ appliedModel: 'mistral-vibe:mistral-medium', deliveredMcpServerCount: 2 });
      sessionId = session.id;
    } finally {
      first.destroy();
    }

    const resumed = createProtocol();
    try {
      const session = await resumed.resumeSession(sessionId, options);
      expect(session.id).toBe(sessionId);
      const events: ProtocolEvent[] = [];
      for await (const event of resumed.sendMessage(session, {
        content: 'Edit a.txt',
        sessionId: 'host',
        attachments: [{
          id: 'image', type: 'image', filename: 'fixture.png', mimeType: 'image/png',
          filepath: fixture, size: 1, addedAt: 0,
        }],
      })) {
        events.push(event);
      }
      expect(onPermissionRequest).toHaveBeenCalledWith(expect.objectContaining({
        nimbalystSessionId: 'host',
        permissionsPath: '/trusted-workspace',
        toolName: 'Edit',
        toolInput: { file_path: 'a.txt' },
      }));
      expect(events).toEqual(expect.arrayContaining([
        { type: 'text', content: 'Done.' },
        { type: 'usage', contextFillTokens: 150, contextWindow: 256000 },
        expect.objectContaining({
          type: 'tool_result',
          toolResult: expect.objectContaining({
            result: expect.objectContaining({
              changes: [expect.objectContaining({ beforeContent: 'one', afterContent: 'two' })],
            }),
          }),
        }),
      ]));
      expect(events.at(-1)).toMatchObject({
        type: 'complete',
        usage: { input_tokens: 100, cache_read_input_tokens: 130, output_tokens: 10, total_tokens: 240 },
      });

      const compact = [];
      for await (const event of resumed.sendMessage(session, { content: '/compact', sessionId: 'host' })) {
        compact.push(event);
      }
      expect(compact).toContainEqual(expect.objectContaining({
        type: 'tool_result', metadata: { contextCompacted: true },
      }));
    } finally {
      resumed.destroy();
    }
  });

  it('preserves an empty measured context and rejects malformed snapshots', () => {
    expect(mapVibeSessionUpdate({ sessionUpdate: 'usage_update', used: 0, size: 32000 })).toEqual([
      { type: 'usage', contextFillTokens: 0, contextWindow: 32000 },
    ]);
    expect(mapVibeSessionUpdate({ sessionUpdate: 'usage_update', used: 100, size: 0 })).toEqual([]);
    expect(mapVibeSessionUpdate({ sessionUpdate: 'usage_update', used: '100', size: 32000 })).toEqual([]);
  });
});
