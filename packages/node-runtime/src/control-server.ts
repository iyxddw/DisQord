import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

import type { NodeLogPage, NodeLogQuery } from './logger.js';

export interface NodeControlStatus {
  readonly program: 'qq-node' | 'discord-node';
  readonly configured: boolean;
  readonly state: 'setup' | 'starting' | 'connected' | 'retrying' | 'stopped';
  readonly detail?: string;
  readonly centralUrl: string;
  readonly platformConnected: boolean;
  readonly startedAt: string;
  readonly logPath?: string;
  readonly configuration?: {
    readonly centralUrl: string;
    readonly platformUrl?: string;
    readonly allowInsecureCentral: boolean;
    readonly platformTokenConfigured: boolean;
  };
}

export interface NodeControlServerOptions {
  readonly host: string;
  readonly port: number;
  readonly staticRoot: string;
  readonly adminToken?: string;
  readonly getStatus: () => NodeControlStatus;
  readonly refreshSessions: () => Promise<void>;
  readonly getLogs?: (query: NodeLogQuery) => NodeLogPage;
  readonly saveSetup?: (input: unknown) => Promise<{ restartRequired: boolean }>;
}

export class NodeControlServer {
  readonly #options: NodeControlServerOptions;
  readonly #server;

  constructor(options: NodeControlServerOptions) {
    if (!isLoopback(options.host) && !options.adminToken) {
      throw new Error('NODE_WEB_TOKEN is required when the node panel is not bound to loopback.');
    }
    this.#options = options;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolveListen, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#options.port, this.#options.host, resolveListen);
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClose, reject) =>
      this.#server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const url = request.url ?? '/';
      const method = request.method ?? 'GET';
      const parsed = new URL(url, 'http://node.local');
      if (parsed.pathname.startsWith('/api/')) {
        if (
          this.#options.adminToken &&
          request.headers.authorization !== `Bearer ${this.#options.adminToken}`
        ) {
          return json(response, 401, { error: 'Node panel token required.' });
        }
        if (method === 'GET' && parsed.pathname === '/api/node/status') {
          return json(response, 200, this.#options.getStatus());
        }
        if (method === 'POST' && parsed.pathname === '/api/node/refresh') {
          await this.#options.refreshSessions();
          return json(response, 200, { ok: true });
        }
        if (method === 'GET' && parsed.pathname === '/api/node/logs') {
          if (!this.#options.getLogs) return json(response, 404, { error: 'Logs unavailable.' });
          return json(response, 200, this.#options.getLogs(parseLogQuery(parsed.searchParams)));
        }
        if (method === 'POST' && parsed.pathname === '/api/node/setup') {
          if (!this.#options.saveSetup) {
            return json(response, 404, { error: 'Node setup is unavailable.' });
          }
          const origin = request.headers.origin;
          const host = request.headers.host;
          if (origin && host && new URL(origin).host !== host) {
            return json(response, 403, { error: 'Cross-origin mutation rejected.' });
          }
          try {
            const result = await this.#options.saveSetup(await readJsonBody(request));
            return json(response, 200, result);
          } catch (error) {
            return json(response, 400, {
              error: error instanceof Error ? error.message : 'Node setup is invalid.',
            });
          }
        }
        return json(response, 404, { error: 'API route not found.' });
      }
      await this.#serveStatic(parsed.pathname, response);
    } catch (error) {
      json(response, 500, {
        error: error instanceof Error ? error.message : 'Node panel failed.',
      });
    }
  }

  async #serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const root = resolve(this.#options.staticRoot);
    const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/u, '');
    const candidate = resolve(root, normalize(requested));
    const file =
      candidate.startsWith(`${root}\\`) || candidate.startsWith(`${root}/`)
        ? candidate
        : join(root, 'index.html');
    const selected =
      existsSync(file) && (await stat(file)).isFile() ? file : join(root, 'index.html');
    if (!existsSync(selected)) {
      return json(response, 503, { error: 'Node web panel has not been built.' });
    }
    response.statusCode = 200;
    response.setHeader('Content-Type', contentType(selected));
    response.setHeader(
      'Cache-Control',
      selected.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable',
    );
    createReadStream(selected).pipe(response);
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) throw new Error('Request body is too large.');
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function parseLogQuery(params: URLSearchParams): NodeLogQuery {
  const page = Number(params.get('page') ?? '1');
  const pageSize = Number(params.get('pageSize') ?? '50');
  const level = params.get('level') ?? 'all';
  return {
    ...(Number.isFinite(page) ? { page } : {}),
    ...(Number.isFinite(pageSize) ? { pageSize } : {}),
    ...(level === 'debug' || level === 'info' || level === 'warn' || level === 'error'
      ? { level }
      : { level: 'all' }),
    ...(params.get('search') ? { search: params.get('search') ?? '' } : {}),
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(JSON.stringify(body));
}

function isLoopback(host: string): boolean {
  return ['127.0.0.1', '::1', 'localhost'].includes(host);
}

function contentType(path: string): string {
  return (
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    }[extname(path)] ?? 'application/octet-stream'
  );
}
