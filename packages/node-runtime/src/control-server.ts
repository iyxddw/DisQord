import { createReadStream, existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

export interface NodeControlStatus {
  readonly program: 'qq-node' | 'discord-node';
  readonly state: 'starting' | 'connected' | 'retrying' | 'stopped';
  readonly detail?: string;
  readonly centralUrl: string;
  readonly platformConnected: boolean;
  readonly startedAt: string;
}

export interface NodeControlServerOptions {
  readonly host: string;
  readonly port: number;
  readonly staticRoot: string;
  readonly adminToken?: string;
  readonly getStatus: () => NodeControlStatus;
  readonly refreshSessions: () => Promise<void>;
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
      void this.#handle(
        request.url ?? '/',
        request.method ?? 'GET',
        request.headers.authorization,
        response,
      );
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

  async #handle(
    url: string,
    method: string,
    authorization: string | undefined,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const parsed = new URL(url, 'http://node.local');
      if (parsed.pathname.startsWith('/api/')) {
        if (this.#options.adminToken && authorization !== `Bearer ${this.#options.adminToken}`) {
          return json(response, 401, { error: 'Node panel token required.' });
        }
        if (method === 'GET' && parsed.pathname === '/api/node/status') {
          return json(response, 200, this.#options.getStatus());
        }
        if (method === 'POST' && parsed.pathname === '/api/node/refresh') {
          await this.#options.refreshSessions();
          return json(response, 200, { ok: true });
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
