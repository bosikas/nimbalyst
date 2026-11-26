// @vitest-environment node
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBrowserHostHandler, startBrowserHost } from '../browserHost';

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
  await writeFile(join(rendererPath, 'browser-host.html'), '<main>Sessions</main>');
  await writeFile(join(workspacePath, 'example.pdf'), '%PDF-1.4');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function setup() {
  const services = {
    listSessions: vi.fn(async () => [{ id: 'local', title: 'Local session' }]),
    getSession: vi.fn(async (id: string) => id === 'local'
      ? { id, provider: 'openai-codex', messages: [], createdAt: 1, updatedAt: 1 }
      : null),
    interruptSession: vi.fn(async () => ({ success: true })),
  };
  const handle = createBrowserHostHandler({ token, workspacePath, pdfPath: 'example.pdf', rendererPath }, services);
  const request = (path: string, method = 'GET', authorized = true) => handle(new Request(
    `http://127.0.0.1:17864${path}`,
    { method, headers: authorized ? { authorization: `Bearer ${token}` } : {} },
  ));
  return { request, services, handle };
}

describe('browser host', () => {
  it('reports invalid configuration without including its contents', async () => {
    const configPath = join(root, 'config.json');
    await writeFile(configPath, `{"token": "${token}" invalid}`);
    await expect(startBrowserHost(configPath, rendererPath, () => setup().services))
      .rejects.toThrow(/^Browser host configuration is not valid JSON$/);
  });

  it('serves the browser entry and requires authentication for session and file data', async () => {
    const { request, services } = setup();
    expect(await (await request('/', 'GET', false)).text()).toBe('<main>Sessions</main>');
    expect((await request('/api/sessions', 'GET', false)).status).toBe(401);
    expect((await request('/api/pdf', 'GET', false)).status).toBe(401);
    expect(services.listSessions).not.toHaveBeenCalled();
    expect(await (await request('/api/sessions')).json()).toEqual([{ id: 'local', title: 'Local session' }]);
    expect(await (await request('/api/pdf')).text()).toBe('%PDF-1.4');
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
