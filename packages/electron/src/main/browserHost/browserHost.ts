import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { SessionData } from '@nimbalyst/runtime/ai/server/types';
import {
  pendingBrowserPermissions, type BrowserHostApproval, type BrowserHostAutomation,
  type BrowserHostExtension, type BrowserHostInfo, type BrowserHostSession,
  type BrowserHostSessionHistory, type BrowserHostSessionSummary,
  type BrowserWorkspaceEvents,
} from '../../shared/browserHost';
import { trackBrowserWorkspaceEvents } from './browserWorkspaceEvents';

type BrowserHostAccess = { token: string; auth?: never } | { auth: 'loopback'; token?: never };

export type BrowserHostConfig = BrowserHostAccess & {
  workspacePath: string;
  rendererPath: string;
  pdfPath?: string;
};

export interface BrowserHostServices {
  getWorkspaceFolders?: () => string[];
  readWorkspaceEvents?: () => BrowserWorkspaceEvents;
  getAppearance?: () => Promise<BrowserHostInfo['appearance']>;
  listSessions: () => Promise<BrowserHostSessionSummary[]>;
  listSessionHistory?: () => Promise<BrowserHostSessionHistory>;
  invokeSessionHistory?: (channel: string, args: unknown[]) => Promise<unknown>;
  getSession: (id: string) => Promise<(BrowserHostSession & Pick<SessionData, 'metadata'>) | null>;
  interruptSession: (id: string) => Promise<{ success: boolean }>;
  queuePrompt: (id: string, prompt: string) => Promise<void>;
  saveDraft?: (id: string, draft: string) => Promise<boolean>;
  respondToPermission: (id: string, requestId: string, decision: BrowserHostApproval) => Promise<{ success: boolean }>;
  listExtensions: () => Promise<BrowserHostExtension[]>;
  readPanelAssets?: (extensionId: string) => Promise<{ source: string; css: string } | null>;
  callPanelTool?: (extensionId: string, toolName: string, args: Record<string, unknown>) => Promise<unknown>;
  invokePanel?: (extensionId: string, channel: string, args: unknown[]) => Promise<unknown>;
  listAutomations: () => Promise<string>;
  createAutomation: (automation: BrowserHostAutomation) => Promise<string>;
}

const maxPdfBytes = 32 * 1024 * 1024;
const maxBodyBytes = 64 * 1024;
const scheduleTime = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const weekdays = new Set(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const loopbackHost = /^127\.0\.0\.1(?::\d{1,5})?$/;
const assetPath = /^\/assets\/[\w][\w./-]*$/;
const contentTypes: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

const securityHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
};

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: securityHeaders });
}

function failure(error: string, status: number): Response {
  return json({ error }, status);
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  if (!request.body || request.headers.get('content-type') !== 'application/json') return null;
  const reader = request.body.getReader();
  try {
    let length = 0;
    const chunks: Uint8Array[] = [];
    for (let read = await reader.read(); !read.done; read = await reader.read()) {
      length += read.value.length;
      if (length > maxBodyBytes) return null;
      chunks.push(read.value);
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

function parseAutomation(input: Record<string, unknown> | null): BrowserHostAutomation | null {
  const title = typeof input?.title === 'string' ? input.title.trim() : '';
  const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
  if (!input || !title || title.length > 120 || !prompt || prompt.length > 32_000) return null;
  if (input.type === 'interval' && typeof input.minutes === 'number' &&
      Number.isInteger(input.minutes) && input.minutes >= 1 && input.minutes <= 10_080) {
    return { title, prompt, schedule: { type: 'interval', minutes: input.minutes } };
  }
  if (typeof input.time !== 'string' || !scheduleTime.test(input.time)) return null;
  if (input.type === 'daily') return { title, prompt, schedule: { type: 'daily', time: input.time } };
  if (input.type === 'weekly' && Array.isArray(input.days) && input.days.length > 0 &&
      input.days.length <= 7 && input.days.every((day) => typeof day === 'string' && weekdays.has(day))) {
    return { title, prompt, schedule: { type: 'weekly', time: input.time, days: [...new Set<string>(input.days)] } };
  }
  return null;
}

function isInside(root: string, filePath: string): boolean {
  const path = relative(root, filePath);
  return path !== '' && path !== '..' && !path.startsWith('..' + sep) && !isAbsolute(path);
}

async function readPdf(config: BrowserHostConfig): Promise<Response> {
  if (!config.pdfPath) return failure('PDF unavailable', 404);
  const filePath = await realpath(resolve(config.workspacePath, config.pdfPath)).catch(() => null);
  if (!filePath || !isInside(config.workspacePath, filePath)) return failure('PDF unavailable', 404);

  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile()) return failure('PDF unavailable', 404);
    if (info.size > maxPdfBytes) return failure('PDF exceeds 32 MB', 413);
    const data = Buffer.alloc(info.size + 1);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead !== info.size) return failure('PDF changed while reading', 409);
    return new Response(new Uint8Array(data.subarray(0, bytesRead)), {
      headers: { ...securityHeaders, 'Content-Type': 'application/pdf' },
    });
  } finally {
    await file.close();
  }
}

export function createBrowserHostHandler(config: BrowserHostConfig, services: BrowserHostServices) {
  const loopbackToken = config.auth === 'loopback' ? randomBytes(32).toString('hex') : undefined;
  const authorization = Buffer.from('Bearer ' + (loopbackToken ?? config.token));

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (!loopbackHost.test(url.host) || (origin && origin !== url.origin)) {
      return failure('Origin denied', 403);
    }

    const pathname = url.pathname;
    if (request.method === 'GET' && (pathname === '/' || pathname === '/prism.js' || assetPath.test(pathname))) {
      const file = pathname === '/' ? 'browser-host.html' : pathname.slice(1);
      const filePath = resolve(config.rendererPath, file);
      const type = pathname === '/' ? 'text/html; charset=utf-8' : contentTypes[extname(file)];
      if (!type || !isInside(config.rendererPath, filePath)) return failure('Not found', 404);

      const data = await readFile(filePath).catch(() => null);
      if (!data) return failure('Browser build asset unavailable', 404);
      if (pathname === '/') {
        const nonce = randomBytes(18).toString('base64');
        const policy = securityHeaders['Content-Security-Policy'].replace(
          "script-src 'self'", `script-src 'self' blob: 'nonce-${nonce}'`,
        );
        const accessMeta = loopbackToken ? `<meta name="browser-host-loopback-token" content="${loopbackToken}">` : '';
        return new Response(data.toString('utf8').replace('<head>', `<head><meta name="extension-import-map" content="${nonce}">${accessMeta}`), {
          headers: {
            ...securityHeaders, 'Content-Type': type, 'Content-Security-Policy': policy,
            'Cross-Origin-Resource-Policy': 'same-origin',
          },
        });
      }
      return new Response(new Uint8Array(data), {
        headers: { ...securityHeaders, 'Content-Type': type },
      });
    }

    const supplied = Buffer.from(request.headers.get('authorization') ?? '');
    if (supplied.length !== authorization.length || !timingSafeEqual(supplied, authorization)) {
      return failure('Access token required', 401);
    }

    if (request.method === 'GET' && pathname === '/api') {
      const info: BrowserHostInfo = {
        workspaceName: basename(config.workspacePath),
        workspacePath: config.workspacePath,
        appearance: await services.getAppearance?.(),
        pdfName: config.pdfPath ? basename(config.pdfPath) : null,
      };
      return json(info);
    }
    if (request.method === 'GET' && pathname === '/api/sessions') {
      const sessions = await services.listSessions();
      return json(sessions.map(({ id, title }) => ({ id, title })));
    }
    if (request.method === 'GET' && pathname === '/api/workspace-events' && services.readWorkspaceEvents) {
      return json(services.readWorkspaceEvents());
    }
    if (request.method === 'GET' && pathname === '/api/session-history' && services.listSessionHistory) {
      return json(await services.listSessionHistory());
    }
    if (request.method === 'POST' && pathname === '/api/session-history/command' && services.invokeSessionHistory) {
      const input = await readBody(request);
      if (typeof input?.channel !== 'string' || !Array.isArray(input.args) || input.args.length > 4) {
        return failure('Invalid Sessions command', 400);
      }
      try {
        return json({ result: await services.invokeSessionHistory(input.channel, input.args) });
      } catch (error) {
        return failure(error instanceof Error ? error.message : 'Sessions command failed', 400);
      }
    }
    if (request.method === 'GET' && pathname === '/api/pdf') {
      return readPdf(config);
    }
    if (request.method === 'GET' && pathname === '/api/extensions') {
      return json(await services.listExtensions());
    }
    const extension = /^\/api\/extensions\/([\w.-]{1,160})\/(panel|tool|invoke)$/.exec(pathname);
    if (extension) {
      const [, id, action] = extension;
      if (action === 'panel' && request.method === 'GET') {
        const assets = await services.readPanelAssets?.(id);
        return assets ? json(assets) : failure('Extension panel unavailable', 404);
      }
      if (action === 'invoke' && request.method === 'POST' && services.invokePanel) {
        const input = await readBody(request);
        if (typeof input?.channel !== 'string' || !/^[\w:-]{1,160}$/.test(input.channel) || !Array.isArray(input.args)) {
          return failure('Invalid extension command request', 400);
        }
        try {
          return json({ result: await services.invokePanel(id, input.channel, input.args) });
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'Extension command failed', 400);
        }
      }
      if (action === 'tool' && request.method === 'POST' && services.callPanelTool) {
        const input = await readBody(request);
        if (typeof input?.toolName !== 'string' || !/^[\w.-]{1,160}$/.test(input.toolName) ||
            !input.args || typeof input.args !== 'object' || Array.isArray(input.args)) {
          return failure('Invalid extension tool request', 400);
        }
        try {
          return json({ result: await services.callPanelTool(id, input.toolName, input.args as Record<string, unknown>) });
        } catch (error) {
          return failure(error instanceof Error ? error.message : 'Extension tool failed', 400);
        }
      }
      return failure('Method denied', 405);
    }
    if (pathname === '/api/automations') {
      if (request.method !== 'GET' && request.method !== 'POST') return failure('Method denied', 405);
      const automation = request.method === 'POST' ? parseAutomation(await readBody(request)) : null;
      if (request.method === 'POST' && !automation) return failure('Invalid automation', 400);
      try {
        const text = automation
          ? await services.createAutomation(automation)
          : await services.listAutomations();
        return json({ text }, automation ? 201 : 200);
      } catch {
        return failure('Open this workspace on the host and enable the Automations extension', 503);
      }
    }

    const match = /^\/api\/sessions\/([\w-]{1,128})(?:\/(interrupt|prompt|permission|draft))?$/.exec(pathname);
    if (!match) return failure('Not found', 404);
    const [, id, action] = match;
    if (request.method !== (action ? 'POST' : 'GET')) return failure('Method denied', 405);
    const session = await services.getSession(id);
    if (!session) return failure('Session unavailable', 404);
    if (action === 'interrupt') {
      const result = await services.interruptSession(id);
      return result.success ? json({ success: true }) : failure('Session could not be interrupted', 409);
    }
    if (action === 'prompt') {
      const input = await readBody(request);
      const prompt = typeof input?.prompt === 'string' ? input.prompt.trim() : '';
      if (!prompt || prompt.length > 32_000) return failure('Invalid prompt', 400);
      await services.queuePrompt(id, prompt);
      return json({ success: true }, 202);
    }
    if (action === 'draft' && services.saveDraft) {
      const input = await readBody(request);
      if (typeof input?.draft !== 'string' || input.draft.length > 32_000) return failure('Invalid draft', 400);
      return await services.saveDraft(id, input.draft) ? json({ success: true }) : failure('Draft could not be saved', 409);
    }
    if (action === 'draft') return failure('Session drafts are unavailable', 404);
    if (action === 'permission') {
      const input = await readBody(request);
      const requestId = input?.requestId;
      const decision = input?.decision;
      if (typeof requestId !== 'string' || (decision !== 'allow' && decision !== 'deny')) {
        return failure('Invalid permission response', 400);
      }
      if (!pendingBrowserPermissions(session.messages).some((prompt) => prompt.requestId === requestId)) {
        return failure('Permission request is no longer pending', 409);
      }
      const result = await services.respondToPermission(id, requestId, decision);
      return result.success ? json({ success: true }) : failure('Permission response could not be delivered', 409);
    }

    const {
      title, provider, messages, createdAt, updatedAt, model, mode, isArchived,
      parentSessionId, worktreeId, worktreePath, tokenUsage, draftInput, processing, queuedPrompts, metadata,
    } = session;
    return json({
      id, title, provider, messages, createdAt, updatedAt, model, mode, isArchived,
      parentSessionId, worktreeId, worktreePath, draftInput, processing, queuedPrompts,
      tokenUsage: tokenUsage ?? (metadata?.tokenUsage as BrowserHostSession['tokenUsage']),
      metadata: metadata && {
        effortLevel: metadata.effortLevel,
        thinkingMode: metadata.thinkingMode,
        sessionStatus: metadata.sessionStatus,
        currentTodos: metadata.currentTodos,
      },
    } satisfies BrowserHostSession);
  };
}

export async function startBrowserHosts(
  configPath: string,
  rendererPath: string,
  createServices: (workspacePath: string) => BrowserHostServices,
) {
  const text = await readFile(configPath, 'utf8');
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    throw new Error('Browser host configuration is not valid JSON');
  }
  const entries = Array.isArray(input) ? input : [input];
  if (entries.length === 0) throw new Error('Browser host requires at least one workspace');
  const configs = await Promise.all(entries.map((entry: unknown) => resolveBrowserHostConfig(entry, rendererPath)));
  const tokens = configs.flatMap(({ token }) => token === undefined ? [] : [token]);
  if (new Set(configs.map(({ port }) => port)).size !== configs.length ||
      new Set(tokens).size !== tokens.length) {
    throw new Error('Browser host requires distinct ports and access tokens');
  }
  await stat(join(rendererPath, 'browser-host.html'));

  const hosts: Array<Awaited<ReturnType<typeof listenBrowserHost>>> = [];
  try {
    for (const { workspacePath, workspaceRoot, port, ...config } of configs) {
      const services = createServices(workspacePath);
      const events = trackBrowserWorkspaceEvents(services.getWorkspaceFolders ?? (() => [workspacePath]));
      try {
        const handle = createBrowserHostHandler({ ...config, workspacePath: workspaceRoot }, {
          ...services, readWorkspaceEvents: events.read,
        });
        hosts.push(await listenBrowserHost(port, handle, events.dispose));
      } catch (error) {
        events.dispose();
        throw error;
      }
    }
    return hosts;
  } catch (error) {
    for (const host of hosts) host.close();
    throw error;
  }
}

async function resolveBrowserHostConfig(input: unknown, rendererPath: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Each browser host configuration must be an object');
  }
  const config = input as Partial<Omit<BrowserHostConfig, 'rendererPath'>> & { port?: number };
  let access: BrowserHostAccess;
  if (config.auth === 'loopback' && config.token === undefined) {
    access = { auth: 'loopback' };
  } else if (config.auth === undefined && typeof config.token === 'string' && /^[a-f0-9]{64}$/.test(config.token)) {
    access = { token: config.token };
  } else {
    throw new Error('Browser host requires a random 32-byte hex token');
  }
  if (typeof config.workspacePath !== 'string' || !isAbsolute(config.workspacePath)) {
    throw new Error('Browser host requires an absolute workspace path');
  }
  if (config.pdfPath !== undefined && (
    typeof config.pdfPath !== 'string' || isAbsolute(config.pdfPath) || extname(config.pdfPath).toLowerCase() !== '.pdf'
  )) {
    throw new Error('Browser host requires a workspace-relative PDF path');
  }
  const port = config.port ?? 17864;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error('Browser host port must be between 1024 and 65535');
  }
  const workspacePath = config.workspacePath;
  const workspaceRoot = await realpath(workspacePath);
  if (!(await stat(workspaceRoot)).isDirectory()) throw new Error('Browser host workspace must be a directory');
  return { ...access, port, workspacePath, workspaceRoot, pdfPath: config.pdfPath, rendererPath };
}

async function listenBrowserHost(port: number, handle: ReturnType<typeof createBrowserHostHandler>, dispose: () => void) {
  const server = createServer(async (request, response) => {
    const host = request.headers.host ?? '';
    let result: Response;
    try {
      if (!loopbackHost.test(host)) {
        result = failure('Host denied', 403);
      } else {
        const target = request.url ?? '/';
        if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) {
          result = failure('Invalid request path', 400);
        } else {
          const init: RequestInit & { duplex?: 'half' } = {
            method: request.method,
            headers: request.headers as HeadersInit,
          };
          if (request.method === 'POST' && request.headers['content-type'] === 'application/json') {
            init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
            init.duplex = 'half';
          }
          result = await handle(new Request('http://' + host + target, init));
        }
      }
    } catch {
      result = failure('Linux host request failed', 500);
    }
    request.resume();
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  server.once('close', dispose);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { port, close: () => server.close() };
}
