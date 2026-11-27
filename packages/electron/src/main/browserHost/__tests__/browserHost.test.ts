// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserHostHandler, startBrowserHosts, type BrowserHostServices } from '../browserHost';
import { notifyBrowserGitChange } from '../browserWorkspaceEvents';

const token = 'a'.repeat(64);
let root: string;
let workspacePath: string;
let rendererPath: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-host-test-'));
  workspacePath = join(root, 'workspace');
  rendererPath = join(root, 'renderer');
  await mkdir(workspacePath);
  workspacePath = await realpath(workspacePath);
  await mkdir(rendererPath);
  await writeFile(join(rendererPath, 'browser-host.html'), '<head><script src="./prism.js"></script></head><main>Sessions</main>');
  await writeFile(join(rendererPath, 'prism.js'), 'window.Prism = {};');
  await writeFile(join(workspacePath, 'example.pdf'), '%PDF-1.4');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup() {
  const services = {
    getAppearance: vi.fn(async () => ({ theme: 'dark' })),
    listSessions: vi.fn(async () => [{ id: 'local', title: 'Local session' }]),
    hasSession: vi.fn(async (id: string) => id === 'local'),
    getSession: vi.fn(async (id: string): ReturnType<BrowserHostServices['getSession']> => id === 'local'
      ? {
        id, provider: 'openai-codex', createdAt: 1, updatedAt: 1,
        messages: [{
          id: 1, sequence: 1, createdAt: new Date(0), type: 'interactive_prompt', subagentId: null,
          interactivePrompt: {
            promptType: 'permission_request', requestId: 'pending', status: 'pending', toolName: 'Read',
            rawCommand: 'read README.md', pattern: 'README.md', patternDisplayName: 'README.md',
            isDestructive: false, warnings: [],
          },
        }],
      }
      : null),
    interruptSession: vi.fn(async () => ({ success: true })),
    sendQueuedPromptNow: vi.fn(async () => ({ success: true })),
    queuePrompt: vi.fn(async () => ({ id: 'queued-1', createdAt: 1234 })),
    saveDraft: vi.fn(async () => true),
    respondToPermission: vi.fn(async () => ({ success: true })),
    listExtensions: vi.fn(async () => [{ id: 'pdf-viewer', name: 'PDF Viewer', version: '1.0.0', enabled: true }]),
    readRailStatus: vi.fn(async () => ({ claude: null, codex: null, gemini: null, vibe: null, badges: {} })),
    readPanelAssets: vi.fn(async (id: string) => id === 'example.extension' ? { source: 'export const panels = {};', css: '' } : null),
    callPanelTool: vi.fn(async () => ({ ready: true })),
    invokePanel: vi.fn(async () => ({ success: true })),
    listAutomations: vi.fn(async () => 'No automations'),
    createAutomation: vi.fn(async () => 'Automation scheduled'),
  };
  const handle = createBrowserHostHandler({ token, workspacePath, pdfPath: 'example.pdf', rendererPath }, services);
  const request = (path: string, method = 'GET', authorized = true) => handle(new Request(
    `http://127.0.0.1:17864${path}`,
    { method, headers: authorized ? { authorization: `Bearer ${token}` } : {} },
  ));
  const post = (path: string, data: unknown) => handle(new Request(`http://127.0.0.1:17864${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(data),
  }));
  return { request, post, services, handle };
}

describe('browser host', () => {
  it('authenticates rail status and validates usage refresh targets', async () => {
    const { request, services } = setup();
    expect((await request('/api/rail-status', 'GET', false)).status).toBe(401);
    expect((await request('/api/rail-status?refresh=unknown')).status).toBe(400);
    expect(services.readRailStatus).not.toHaveBeenCalled();
    expect(await (await request('/api/rail-status?refresh=vibe')).json()).toEqual({
      claude: null, codex: null, gemini: null, vibe: null, badges: {},
    });
    expect(services.readRailStatus).toHaveBeenCalledWith('vibe');
  });

  it('authenticates appearance, extension assets and extension tool calls', async () => {
    const { request, post, services } = setup();
    expect((await request('/api', 'GET', false)).status).toBe(401);
    expect((await (await request('/api')).json()).appearance).toEqual({ theme: 'dark' });
    const page = await request('/', 'GET', false);
    const html = await page.text();
    expect(html).toContain('<script src="./prism.js"></script>');
    expect(await (await request('/prism.js', 'GET', false)).text()).toBe('window.Prism = {};');
    const nonce = /name="extension-import-map" content="([^"]+)"/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(page.headers.get('Content-Security-Policy')).toContain(`'nonce-${nonce}'`);
    expect((await request('/api/extensions/example.extension/panel', 'GET', false)).status).toBe(401);
    expect(services.readPanelAssets).not.toHaveBeenCalled();
    expect((await request('/api/extensions/unknown/panel')).status).toBe(404);
    expect((await (await request('/api/extensions/example.extension/panel')).json()).source).toContain('export');
    expect((await request('/api/extensions/example.extension/tool', 'POST', false)).status).toBe(401);
    expect((await post('/api/extensions/example.extension/tool', { toolName: 'example.status', args: [] })).status).toBe(400);
    expect(services.callPanelTool).not.toHaveBeenCalled();
    expect(await (await post('/api/extensions/example.extension/tool', {
      toolName: 'example.status', args: { verbose: true },
    })).json()).toEqual({ result: { ready: true } });
    expect(services.callPanelTool).toHaveBeenCalledWith('example.extension', 'example.status', { verbose: true });
    expect((await request('/api/extensions/example.extension/invoke', 'POST', false)).status).toBe(401);
    expect((await post('/api/extensions/example.extension/invoke', { channel: 'sessions:list', args: {} })).status).toBe(400);
    expect(services.invokePanel).not.toHaveBeenCalled();
    expect(await (await post('/api/extensions/example.extension/invoke', {
      channel: 'sessions:list', args: [workspacePath],
    })).json()).toEqual({ result: { success: true } });
    expect(services.invokePanel).toHaveBeenCalledWith('example.extension', 'sessions:list', [workspacePath]);
  });
  it('reports invalid configuration without including its contents', async () => {
    const configPath = join(root, 'config.json');
    await writeFile(configPath, `{"token": "${token}" invalid}`);
    await expect(startBrowserHosts(configPath, rendererPath, () => setup().services))
      .rejects.toThrow(/^Browser host configuration is not valid JSON$/);
  });

  it('signs in from the loopback page with an automatically generated workspace credential', async () => {
    const { services } = setup();
    const handle = createBrowserHostHandler({ auth: 'loopback', workspacePath, rendererPath }, services);
    const url = 'http://127.0.0.1:17865';
    const page = await handle(new Request(url));
    const key = /name="browser-host-loopback-token" content="([a-f0-9]{64})"/.exec(await page.text())?.[1];
    expect(key).toHaveLength(64);
    expect(page.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
    expect((await handle(new Request(url, { headers: { origin: 'https://other.test' } }))).status).toBe(403);
    expect((await handle(new Request('http://192.168.1.84:17865/'))).status).toBe(403);
    expect((await handle(new Request(url + '/api/sessions'))).status).toBe(401);
    expect(services.listSessions).not.toHaveBeenCalled();
    const headers = { authorization: `Bearer ${key}` };
    const sessions = await handle(new Request(url + '/api/sessions', { headers }));
    expect(await sessions.json()).toEqual([{ id: 'local', title: 'Local session' }]);
    const other = createBrowserHostHandler({ auth: 'loopback', workspacePath, rendererPath }, services);
    expect((await other(new Request(url + '/api/sessions', { headers }))).status).toBe(401);
  });

  it('binds each configured workspace to its own loopback port and token', async () => {
    const secondWorkspace = join(root, 'nimbalyst');
    await mkdir(secondWorkspace);
    const listeners = [createServer(), createServer()];
    const ports = await Promise.all(listeners.map((server) => new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') reject(new Error('No test port'));
        else resolve(address.port);
      });
    })));
    await Promise.all(listeners.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));

    const secondToken = 'b'.repeat(64);
    const configPath = join(root, 'browser-host.json');
    await writeFile(configPath, JSON.stringify([
      { workspacePath, port: ports[0], token },
      { workspacePath: secondWorkspace, port: ports[1], token: secondToken },
    ]));
    const attached = join(root, 'attached');
    const folders = [workspacePath];
    const hosts = await startBrowserHosts(configPath, rendererPath, (path) => ({
      ...setup().services,
      getWorkspaceFolders: () => path === workspacePath ? folders : [path],
      listSessions: async () => [{ id: 'local', title: path }],
    }));
    try {
      const sessions = (port: number, key: string) =>
        fetch(`http://127.0.0.1:${port}/api/sessions`, { headers: { authorization: `Bearer ${key}` } });
      expect(await (await sessions(ports[0], token)).json()).toEqual([{ id: 'local', title: workspacePath }]);
      expect(await (await sessions(ports[1], secondToken)).json()).toEqual([{ id: 'local', title: secondWorkspace }]);
      expect((await sessions(ports[0], secondToken)).status).toBe(401);
      expect((await sessions(ports[1], token)).status).toBe(401);
      const workspaceEvents = (port: number, key: string) =>
        fetch(`http://127.0.0.1:${port}/api/workspace-events`, { headers: { authorization: `Bearer ${key}` } });
      expect((await workspaceEvents(ports[0], secondToken)).status).toBe(401);
      expect(await (await workspaceEvents(ports[0], token)).json()).toEqual({ folders: [workspacePath], gitRevision: 0 });
      folders.push(attached);
      notifyBrowserGitChange(join(attached, 'nested-repo'));
      expect(await (await workspaceEvents(ports[0], token)).json()).toEqual({
        folders: [workspacePath, attached], gitRevision: 1,
      });
      expect(await (await workspaceEvents(ports[1], secondToken)).json()).toEqual({ folders: [secondWorkspace], gitRevision: 0 });
    } finally {
      for (const host of hosts) host.close();
    }
  });

  it('serves the browser entry and requires authentication for session and file data', async () => {
    const { request, services } = setup();
    expect(await (await request('/', 'GET', false)).text()).toContain('<main>Sessions</main>');
    expect((await request('/api/sessions', 'GET', false)).status).toBe(401);
    expect((await request('/api/pdf', 'GET', false)).status).toBe(401);
    expect(services.listSessions).not.toHaveBeenCalled();
    expect(await (await request('/api/sessions')).json()).toEqual([{ id: 'local', title: 'Local session' }]);
    expect(await (await request('/api/pdf')).text()).toBe('%PDF-1.4');
  });

  it('serves the native session list model only after authentication', async () => {
    const { request, services } = setup();
    const history = [{
      id: 'local', title: 'Local session', provider: 'codex', sessionType: 'session',
      workspaceId: '/example', worktreeId: null, parentSessionId: null,
      childCount: 0, uncommittedCount: 0, createdAt: 1, updatedAt: 2,
      messageCount: 0, isArchived: false, isPinned: true, processing: true,
    }];
    Object.assign(services, { listSessionHistory: vi.fn(async () => history) });
    expect((await request('/api/session-history', 'GET', false)).status).toBe(401);
    expect(await (await request('/api/session-history')).json()).toEqual(history);
    expect(services.listSessions).not.toHaveBeenCalled();
  });

  it('checks workspace membership before sending an interrupt', async () => {
    const { request, services } = setup();
    expect((await request('/api/sessions/outside', 'GET')).status).toBe(404);
    expect((await request('/api/sessions/outside/interrupt', 'POST')).status).toBe(404);
    expect(services.interruptSession).not.toHaveBeenCalled();
    expect((await request('/api/sessions/local')).status).toBe(200);
    expect((await request('/api/sessions/local/interrupt', 'POST')).status).toBe(200);
    expect(services.interruptSession).toHaveBeenCalledWith('local');
  });

  it('returns persisted context usage without exposing private session metadata', async () => {
    const { request, services } = setup();
    const session = (await services.getSession('local'))!;
    const tokenUsage = {
      inputTokens: 8100, outputTokens: 90, totalTokens: 8190, contextWindow: 200000,
      currentContext: { tokens: 8100, contextWindow: 200000 },
    };
    const metadata = { tokenUsage, providerSessionId: 'private-session-id' };
    services.getSession.mockResolvedValue({ ...session, metadata });

    const response = await (await request('/api/sessions/local')).json();
    expect(response.tokenUsage).toEqual(tokenUsage);
    expect(response.metadata).toEqual({});
  });

  it('returns an empty response for unchanged session snapshots and delivers updates', async () => {
    const { handle, request, services } = setup();
    const initial = await request('/api/sessions/local');
    const etag = initial.headers.get('etag');
    expect(etag).toBeTruthy();
    const conditional = (authorized = true) => handle(new Request('http://127.0.0.1:17864/api/sessions/local', {
      headers: { 'if-none-match': etag!, ...(authorized ? { authorization: `Bearer ${token}` } : {}) },
    }));
    expect((await conditional(false)).status).toBe(401);
    const unchanged = await conditional();
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe('');
    expect(unchanged.headers.get('cache-control')).toBe('no-store');
    const existing = (await services.getSession('local'))!;
    services.getSession.mockResolvedValue({ ...existing, processing: true });
    const changed = await conditional();
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).not.toBe(etag);
    expect((await changed.json()).processing).toBe(true);
  });

  it('sends a queued prompt now only for a valid request in the current workspace', async () => {
    const { request, post, services } = setup();
    expect((await request('/api/sessions/local/send-now', 'POST', false)).status).toBe(401);
    expect((await post('/api/sessions/outside/send-now', { promptId: 'queued-1' })).status).toBe(404);
    expect((await post('/api/sessions/local/send-now', { promptId: '' })).status).toBe(400);
    expect(services.sendQueuedPromptNow).not.toHaveBeenCalled();
    expect((await post('/api/sessions/local/send-now', { promptId: 'queued-1' })).status).toBe(202);
    expect(services.sendQueuedPromptNow).toHaveBeenCalledExactlyOnceWith('local', 'queued-1');
    services.sendQueuedPromptNow.mockResolvedValueOnce({ success: false });
    expect((await post('/api/sessions/local/send-now', { promptId: 'missing' })).status).toBe(409);
    expect(services.getSession).not.toHaveBeenCalled();
  });

  it('serves session panel state and keeps model metadata and drafts scoped', async () => {
    const { request, post, services } = setup();
    const existing = await services.getSession('local');
    const metadata = { effortLevel: 'high', unrelatedHostData: 'private' };
    services.getSession.mockResolvedValueOnce({
      ...existing!, model: 'openai-codex:gpt-5.4', mode: 'agent', processing: true, metadata,
    });
    const snapshot = await (await request('/api/sessions/local')).json();
    expect(snapshot).toMatchObject({
      model: 'openai-codex:gpt-5.4', mode: 'agent', processing: true, metadata: { effortLevel: 'high' },
    });
    expect(snapshot.metadata).not.toHaveProperty('unrelatedHostData');
    expect((await request('/api/sessions/local/draft', 'POST', false)).status).toBe(401);
    expect((await post('/api/sessions/outside/draft', { draft: 'outside' })).status).toBe(404);
    expect((await post('/api/sessions/local/draft', { draft: 42 })).status).toBe(400);
    expect(services.saveDraft).not.toHaveBeenCalled();
    expect((await post('/api/sessions/local/draft', { draft: '' })).status).toBe(200);
    expect(services.saveDraft).toHaveBeenCalledWith('local', '');
  });

  it('queues only valid prompts for sessions in the selected workspace', async () => {
    const { post, services } = setup();
    expect((await post('/api/sessions/outside/prompt', { prompt: 'Run checks' })).status).toBe(404);
    expect((await post('/api/sessions/local/prompt', { prompt: ' ' })).status).toBe(400);
    expect((await post('/api/sessions/local/prompt', { prompt: 'x'.repeat(65_536) })).status).toBe(400);
    const accepted = await post('/api/sessions/local/prompt', { prompt: '  Run checks  ' });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ success: true, receipt: { id: 'queued-1', createdAt: 1234 } });
    expect(services.queuePrompt).toHaveBeenCalledExactlyOnceWith('local', 'Run checks');
    expect(services.getSession).not.toHaveBeenCalled();
  });

  it('answers pending permissions for the selected session only', async () => {
    const { post, services } = setup();
    expect((await post('/api/sessions/outside/permission', { requestId: 'pending', decision: 'allow' })).status).toBe(404);
    expect((await post('/api/sessions/local/permission', { requestId: 'missing', decision: 'allow' })).status).toBe(409);
    expect((await post('/api/sessions/local/permission', { requestId: 'pending', decision: 'always' })).status).toBe(400);
    expect((await post('/api/sessions/local/permission', { requestId: 'pending', decision: 'deny' })).status).toBe(200);
    expect(services.respondToPermission).toHaveBeenCalledExactlyOnceWith('local', 'pending', 'deny');
  });

  it('exposes installed extension status and forwards validated schedules only', async () => {
    const { post, request, services } = setup();
    expect((await request('/api/extensions', 'GET', false)).status).toBe(401);
    expect(await (await request('/api/extensions')).json()).toEqual([
      { id: 'pdf-viewer', name: 'PDF Viewer', version: '1.0.0', enabled: true },
    ]);
    expect(await (await request('/api/automations')).json()).toEqual({ text: 'No automations' });
    const input = { title: 'Status', prompt: 'Summarize the project', type: 'weekly', time: '12:30' };
    expect((await post('/api/automations', { ...input, days: ['holiday'] })).status).toBe(400);
    expect((await post('/api/automations', { ...input, time: '99:00', days: ['mon'] })).status).toBe(400);
    expect((await post('/api/automations', { ...input, days: ['mon', 'mon', 'fri'] })).status).toBe(201);
    expect(services.createAutomation).toHaveBeenCalledExactlyOnceWith({
      title: 'Status', prompt: 'Summarize the project', schedule: { type: 'weekly', time: '12:30', days: ['mon', 'fri'] },
    });
  });

  it('rejects cross-origin requests, rebinding hosts, and a PDF symlink outside the workspace', async () => {
    const { request, handle } = setup();
    await rm(join(workspacePath, 'example.pdf'));
    await writeFile(join(root, 'private.pdf'), 'private data');
    await symlink(join(root, 'private.pdf'), join(workspacePath, 'example.pdf'));
    expect((await request('/api/pdf')).status).toBe(404);
    expect((await handle(new Request('http://untrusted.test/api/sessions'))).status).toBe(403);
    expect((await handle(new Request('http://127.0.0.1:17864/api/sessions/local/interrupt', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, origin: 'https://untrusted.test' },
    }))).status).toBe(403);
  });
});
