import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { contentTypeFor } from './mime.js';
import { resolveStaticPath } from './path.js';
import { parseRange } from './range.js';

export interface ServedRequest {
  method: string;
  /** URL path of the request, or the raw target when it could not be parsed. */
  path: string;
  status: number;
  /**
   * `file`: the file named by the URL. `index`: a directory's index file. `clean-url`: `.html` or
   * `/index.html` added to the path. `fallback`: the SPA index for a client route. `none`: no file was sent.
   */
  served: 'file' | 'index' | 'clean-url' | 'fallback' | 'none';
}

export interface StaticOptions {
  /** Folder to serve. */
  root: string;
  /** Name of a directory's index file. Default `index.html`. */
  index?: string;
  /**
   * Answer unknown paths without a file extension with the index file (status 200), for client-side
   * routing. Paths whose last segment has an extension stay 404, so a missing asset is never hidden.
   * Pass `{ exclude: ['/api'] }` to keep path prefixes out of the fallback.
   */
  spaFallback?: boolean | { exclude?: string[] };
  /** Try `<path>.html` and `<path>/index.html` for extensionless paths. Default false. */
  cleanUrls?: boolean;
  /** Answer `Range` requests with 206 and 416. Default true. */
  ranges?: boolean;
  /** `Cache-Control` value, or a function of the URL path. Default `no-cache`. */
  cacheControl?: string | ((urlPath: string) => string);
  /** Extra response headers, or a function of the file path that returns them. */
  headers?: Record<string, string> | ((file: string) => Record<string, string>);
  /** Extra content types by extension, for example `{ '.glb': 'model/gltf-binary' }`. */
  mime?: Record<string, string>;
  /** File inside the root sent with 404 responses, for example `404.html`. */
  notFoundFile?: string;
  /** Answer 404 for any path with a segment that starts with a dot. Default false. */
  blockDotfiles?: boolean;
  /** URL prefix the site is mounted under, for example `/docs`. Paths outside it are 404. */
  basePath?: string;
  /** Accepted `Host` header names (without port). Others get 403. Default: any host. */
  allowedHosts?: string[];
  /** Called once per finished request. */
  onRequest?: (request: ServedRequest) => void;
}

export interface StartOptions extends StaticOptions {
  /** Port to listen on; 0 picks a free one. Default 0. */
  port?: number;
  /** Interface to bind. Default `127.0.0.1`. */
  host?: string;
}

export interface RunningServer {
  server: Server;
  host: string;
  port: number;
  /** `http://host:port`. */
  url: string;
  close(): Promise<void>;
}

export type StaticHandler = (request: IncomingMessage, response: ServerResponse) => Promise<void>;

type Found = { file: string; served: ServedRequest['served'] };
type Located = Found | 'redirect' | 'bad-request' | 'forbidden' | null;

/** Builds a `(req, res)` handler that serves `options.root`. Use it with `http.createServer` or inside another server. */
export function createStaticHandler(options: StaticOptions): StaticHandler {
  const root = path.resolve(options.root);
  const indexName = options.index ?? 'index.html';
  const rangesOn = options.ranges ?? true;
  const basePath = normalizeBase(options.basePath);
  const hosts = options.allowedHosts ? new Set(options.allowedHosts.map((host) => host.toLowerCase())) : null;
  const exclude = typeof options.spaFallback === 'object' ? (options.spaFallback.exclude ?? []) : [];

  async function locate(local: string, decoded: string): Promise<Located> {
    const first = await resolveStaticPath(root, local);
    if (!first.ok) {
      if (first.problem === 'bad-request') return 'bad-request';
      if (first.problem === 'forbidden') return 'forbidden';
    } else if (first.isDirectory) {
      if (!local.endsWith('/')) return 'redirect';
      const inner = await resolveStaticPath(root, `${local}${indexName}`);
      if (inner.ok && !inner.isDirectory) return { file: inner.file, served: 'index' };
    } else {
      return { file: first.file, served: 'file' };
    }

    const lastSegment = decoded.split('/').filter(Boolean).pop() ?? '';
    const extensionless = path.extname(lastSegment) === '';
    if (options.cleanUrls && extensionless && lastSegment !== '' && !decoded.endsWith('/')) {
      for (const candidate of [`${local}.html`, `${local}/${indexName}`]) {
        const hit = await resolveStaticPath(root, candidate);
        if (hit.ok && !hit.isDirectory) return { file: hit.file, served: 'clean-url' };
      }
    }
    const excluded = exclude.some((prefix) => decoded === prefix || decoded.startsWith(`${prefix.replace(/\/$/, '')}/`));
    if (options.spaFallback && extensionless && !excluded) {
      const shell = await resolveStaticPath(root, `/${indexName}`);
      if (shell.ok && !shell.isDirectory) return { file: shell.file, served: 'fallback' };
    }
    return null;
  }

  return async (request, response) => {
    const method = request.method ?? 'GET';
    let logged = false;
    const finish = (status: number, urlPath: string, served: ServedRequest['served']) => {
      if (logged) return;
      logged = true;
      options.onRequest?.({ method, path: urlPath, status, served });
    };
    const reply = (status: number, urlPath: string, body: string, extra: Record<string, string> = {}) => {
      response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...extra });
      response.end(method === 'HEAD' ? undefined : body);
      finish(status, urlPath, 'none');
    };
    const notFound = async (urlPath: string) => {
      if (options.notFoundFile) {
        const page = await resolveStaticPath(root, `/${options.notFoundFile}`);
        if (page.ok && !page.isDirectory) {
          const body = await readFile(page.file);
          response.writeHead(404, { 'content-type': contentTypeFor(page.file, options.mime), 'content-length': body.length, 'cache-control': 'no-store' });
          response.end(method === 'HEAD' ? undefined : body);
          finish(404, urlPath, 'none');
          return;
        }
      }
      reply(404, urlPath, 'Not found\n');
    };
    const send = async (found: Found, urlPath: string) => {
      const info = await stat(found.file);
      const cache = typeof options.cacheControl === 'function' ? options.cacheControl(urlPath) : (options.cacheControl ?? 'no-cache');
      const custom = typeof options.headers === 'function' ? options.headers(found.file) : (options.headers ?? {});
      const headers: Record<string, string | number> = {
        ...custom,
        'content-type': contentTypeFor(found.file, options.mime),
        'cache-control': cache,
        'last-modified': info.mtime.toUTCString(),
      };
      if (rangesOn) headers['accept-ranges'] = 'bytes';

      const range = rangesOn ? parseRange(request.headers.range, info.size) : null;
      if (range === 'unsatisfiable') {
        response.writeHead(416, { ...headers, 'content-range': `bytes */${info.size}`, 'content-length': 0 });
        response.end();
        finish(416, urlPath, 'none');
        return;
      }
      const status = range === null ? 200 : 206;
      headers['content-length'] = range === null ? info.size : range.end - range.start + 1;
      if (range !== null) headers['content-range'] = `bytes ${range.start}-${range.end}/${info.size}`;
      response.writeHead(status, headers);
      finish(status, urlPath, found.served);
      if (method === 'HEAD' || info.size === 0) {
        response.end();
        return;
      }
      createReadStream(found.file, range === null ? undefined : { start: range.start, end: range.end })
        .on('error', () => response.destroy())
        .pipe(response);
    };

    try {
      if (hosts !== null) {
        const host = (request.headers.host ?? '').toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
        if (!hosts.has(host)) return reply(403, request.url ?? '/', 'Host not allowed\n');
      }
      if (method !== 'GET' && method !== 'HEAD') return reply(405, request.url ?? '/', 'Method not allowed\n', { allow: 'GET, HEAD' });

      let urlPath: string;
      try {
        urlPath = new URL(request.url ?? '/', 'http://localhost').pathname;
        decodeURIComponent(urlPath);
      } catch {
        return reply(400, request.url ?? '/', 'Bad request\n');
      }

      let local = urlPath;
      if (basePath !== '') {
        if (urlPath === basePath) {
          response.writeHead(301, { location: `${basePath}/` });
          response.end();
          return finish(301, urlPath, 'none');
        }
        if (!urlPath.startsWith(`${basePath}/`)) return await notFound(urlPath);
        local = urlPath.slice(basePath.length);
      }

      const decoded = safeDecode(local);
      if (options.blockDotfiles && decoded.split('/').some((segment) => segment.startsWith('.'))) return await notFound(urlPath);

      const outcome = await locate(local, decoded);
      if (outcome === 'redirect') {
        response.writeHead(301, { location: `${urlPath}/` });
        response.end();
        return finish(301, urlPath, 'none');
      }
      if (outcome === 'bad-request') return reply(400, urlPath, 'Bad request\n');
      if (outcome === 'forbidden') return reply(403, urlPath, 'Forbidden\n');
      if (outcome === null) return await notFound(urlPath);
      await send(outcome, urlPath);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Server error\n');
      } else response.destroy();
      finish(500, request.url ?? '/', 'none');
    }
  };
}

/** An `http.Server` that serves `options.root`. It is not listening yet. */
export function createStaticServer(options: StaticOptions): Server {
  const handler = createStaticHandler(options);
  return createServer((request, response) => {
    void handler(request, response);
  });
}

/** Starts serving `options.root` and resolves once the server is listening. */
export async function startStaticServer(options: StartOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const server = createStaticServer(options);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  const shown = host.includes(':') ? `[${host}]` : host;
  return {
    server,
    host,
    port,
    url: `http://${shown}:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

function normalizeBase(base: string | undefined): string {
  const trimmed = (base ?? '').split('/').filter(Boolean).join('/');
  return trimmed === '' ? '' : `/${trimmed}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
