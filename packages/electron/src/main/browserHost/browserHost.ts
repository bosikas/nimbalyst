import { timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrowserHostInfo, BrowserHostSession, BrowserHostSessionSummary } from '../../shared/browserHost';

export interface BrowserHostConfig {
  token: string;
  workspacePath: string;
  rendererPath: string;
  pdfPath?: string;
}

export interface BrowserHostServices {
  listSessions: () => Promise<BrowserHostSessionSummary[]>;
  getSession: (id: string) => Promise<BrowserHostSession | null>;
  interruptSession: (id: string) => Promise<{ success: boolean }>;
}

const maxPdfBytes = 32 * 1024 * 1024;
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
  const authorization = Buffer.from('Bearer ' + config.token);

  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (!loopbackHost.test(url.host) || (origin && origin !== url.origin)) {
      return failure('Origin denied', 403);
    }

    const pathname = url.pathname;
    if (request.method === 'GET' && (pathname === '/' || assetPath.test(pathname))) {
      const file = pathname === '/' ? 'browser-host.html' : pathname.slice(1);
      const filePath = resolve(config.rendererPath, file);
      const type = pathname === '/' ? 'text/html; charset=utf-8' : contentTypes[extname(file)];
      if (!type || !isInside(config.rendererPath, filePath)) return failure('Not found', 404);

      const data = await readFile(filePath).catch(() => null);
      if (!data) return failure('Browser build asset unavailable', 404);
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
        pdfName: config.pdfPath ? basename(config.pdfPath) : null,
      };
      return json(info);
    }
    if (request.method === 'GET' && pathname === '/api/sessions') {
      const sessions = await services.listSessions();
      return json(sessions.map(({ id, title }) => ({ id, title })));
    }
    if (request.method === 'GET' && pathname === '/api/pdf') {
      return readPdf(config);
    }

    const match = /^\/api\/sessions\/([\w-]{1,128})(\/interrupt)?$/.exec(pathname);
    if (!match) return failure('Not found', 404);
    const [, id, interrupt] = match;
    if (request.method !== (interrupt ? 'POST' : 'GET')) return failure('Method denied', 405);
    const session = await services.getSession(id);
    if (!session) return failure('Session unavailable', 404);
    if (interrupt) {
      const result = await services.interruptSession(id);
      return result.success ? json({ success: true }) : failure('Session could not be interrupted', 409);
    }

    const { title, provider, messages, createdAt, updatedAt } = session;
    return json({ id, title, provider, messages, createdAt, updatedAt });
  };
}

export async function startBrowserHost(
  configPath: string,
  rendererPath: string,
  createServices: (workspacePath: string) => BrowserHostServices,
) {
  const text = await readFile(configPath, 'utf8');
  let config: Partial<Omit<BrowserHostConfig, 'rendererPath'>> & {
    port?: number;
  };
  try {
    config = JSON.parse(text);
  } catch {
    throw new Error('Browser host configuration is not valid JSON');
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Browser host configuration must be an object');
  }
  if (typeof config.token !== 'string' || !/^[a-f0-9]{64}$/.test(config.token)) {
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
  await stat(join(rendererPath, 'browser-host.html'));
  const handle = createBrowserHostHandler({
    token: config.token,
    pdfPath: config.pdfPath,
    workspacePath: workspaceRoot,
    rendererPath,
  }, createServices(workspacePath));

  const server = createServer(async (request, response) => {
    request.resume();
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
          result = await handle(new Request('http://' + host + target, {
            method: request.method,
            headers: request.headers as HeadersInit,
          }));
        }
      }
    } catch {
      result = failure('Linux host request failed', 500);
    }
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return { port, close: () => server.close() };
}
