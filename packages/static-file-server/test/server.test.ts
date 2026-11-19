import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentTypeFor, parseRange, resolveStaticPath, startStaticServer } from '../src/index.js';
import type { RunningServer, ServedRequest, StartOptions } from '../src/index.js';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/** Sends the request target as written; fetch would normalise `..` away before it left the process. */
function raw(server: RunningServer, target: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: server.host, port: server.port, path: target, method: init.method ?? 'GET', headers: init.headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

let outer: string;
let site: string;
const running: RunningServer[] = [];
const log: ServedRequest[] = [];

async function start(extra: Partial<StartOptions> = {}) {
  const server = await startStaticServer({ root: site, ...extra });
  running.push(server);
  return server;
}

beforeAll(async () => {
  outer = await mkdtemp(path.join(tmpdir(), 'static-file-server-'));
  site = path.join(outer, 'site');
  await mkdir(path.join(site, 'docs'), { recursive: true });
  await mkdir(path.join(site, 'assets'), { recursive: true });
  await mkdir(path.join(site, '.hidden'), { recursive: true });
  await writeFile(path.join(outer, 'secret.txt'), 'top secret');
  await writeFile(path.join(site, 'index.html'), '<h1>home</h1>');
  await writeFile(path.join(site, '404.html'), '<h1>missing page</h1>');
  await writeFile(path.join(site, 'about.html'), '<h1>about</h1>');
  await writeFile(path.join(site, 'docs', 'index.html'), '<h1>docs</h1>');
  await writeFile(path.join(site, 'assets', 'app.js'), 'console.log(1)');
  await writeFile(path.join(site, 'assets', 'data.bin'), '0123456789');
  await writeFile(path.join(site, 'assets', 'model.glb'), 'glb');
  await writeFile(path.join(site, 'assets', 'empty.txt'), '');
  await writeFile(path.join(site, 'a..b.txt'), 'dots');
  await writeFile(path.join(site, 'café.txt'), 'coffee');
  await writeFile(path.join(site, '.hidden', 'x.txt'), 'hidden');
  try {
    await symlink(path.join(outer, 'secret.txt'), path.join(site, 'link.txt'));
  } catch {
    // Symlinks may be unavailable; the symlink test skips itself.
  }
});

afterAll(async () => {
  await Promise.all(running.map((server) => server.close()));
  await rm(outer, { recursive: true, force: true });
});

describe('parseRange', () => {
  it('returns null when there is no usable range', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
    expect(parseRange('bytes=0-1,4-5', 10)).toBeNull();
    expect(parseRange('garbage', 10)).toBeNull();
  });

  it('parses closed, open-ended and suffix ranges', () => {
    expect(parseRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-50', 10)).toEqual({ start: 0, end: 9 });
  });

  it('clamps an end past the last byte', () => {
    expect(parseRange('bytes=5-99', 10)).toEqual({ start: 5, end: 9 });
  });

  it('flags ranges outside the file', () => {
    expect(parseRange('bytes=10-12', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=6-2', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-0', 0)).toBe('unsatisfiable');
  });
});

describe('contentTypeFor', () => {
  it('maps known extensions case-insensitively', () => {
    expect(contentTypeFor('a/b/page.HTML')).toBe('text/html; charset=utf-8');
    expect(contentTypeFor('x.woff2')).toBe('font/woff2');
  });

  it('falls back to octet-stream and honours extra entries', () => {
    expect(contentTypeFor('model.glb')).toBe('application/octet-stream');
    expect(contentTypeFor('model.glb', { '.glb': 'model/gltf-binary' })).toBe('model/gltf-binary');
    expect(contentTypeFor('x.js', { '.JS': 'application/x-custom' })).toBe('application/x-custom');
  });
});

describe('resolveStaticPath', () => {
  it('finds files and directories', async () => {
    const file = await resolveStaticPath(site, '/about.html');
    expect(file).toEqual({ ok: true, file: path.join(site, 'about.html'), isDirectory: false });
    const dir = await resolveStaticPath(site, '/docs');
    expect(dir).toMatchObject({ ok: true, isDirectory: true });
  });

  it('rejects traversal in every spelling', async () => {
    for (const target of ['/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt', '/docs/../../secret.txt']) {
      expect(await resolveStaticPath(site, target)).toEqual({ ok: false, problem: 'forbidden' });
    }
  });

  it('rejects backslashes, NUL bytes and broken escapes', async () => {
    for (const target of ['/..%5Csecret.txt', '/a%00b', '/%E0%A4%A']) {
      expect(await resolveStaticPath(site, target)).toEqual({ ok: false, problem: 'bad-request' });
    }
  });

  it('allows file names that only contain two dots', async () => {
    expect(await resolveStaticPath(site, '/a..b.txt')).toMatchObject({ ok: true });
  });

  it('reports missing entries', async () => {
    expect(await resolveStaticPath(site, '/nope.txt')).toEqual({ ok: false, problem: 'not-found' });
  });

  it('refuses a symlink that leaves the root', async (ctx) => {
    const result = await resolveStaticPath(site, '/link.txt');
    if (result.ok === false && result.problem === 'not-found') ctx.skip();
    expect(result).toEqual({ ok: false, problem: 'forbidden' });
  });
});

describe('serving files', () => {
  it('serves a file with type, length and cache headers', async () => {
    const server = await start();
    const res = await raw(server, '/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.body).toBe('console.log(1)');
    expect(res.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(res.headers['content-length']).toBe('14');
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('serves index.html for the root and for directories with a trailing slash', async () => {
    const server = await start();
    expect((await raw(server, '/')).body).toBe('<h1>home</h1>');
    expect((await raw(server, '/docs/')).body).toBe('<h1>docs</h1>');
  });

  it('redirects a directory without a trailing slash', async () => {
    const server = await start();
    const res = await raw(server, '/docs');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('/docs/');
  });

  it('decodes percent-encoded names and ignores the query string', async () => {
    const server = await start();
    expect((await raw(server, '/caf%C3%A9.txt?v=2')).body).toBe('coffee');
  });

  it('answers HEAD without a body', async () => {
    const server = await start();
    const res = await raw(server, '/assets/app.js', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-length']).toBe('14');
  });

  it('serves an empty file', async () => {
    const server = await start();
    const res = await raw(server, '/assets/empty.txt');
    expect(res.status).toBe(200);
    expect(res.headers['content-length']).toBe('0');
  });

  it('refuses other methods with 405', async () => {
    const server = await start();
    const res = await raw(server, '/', { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('GET, HEAD');
  });
});

describe('traversal over HTTP', () => {
  it('never returns a file outside the root', async () => {
    const server = await start();
    for (const target of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%2fsecret.txt', '/assets/../../secret.txt', '/..%5csecret.txt']) {
      const res = await raw(server, target);
      expect([400, 403, 404]).toContain(res.status);
      expect(res.body).not.toContain('top secret');
    }
  });

  it('refuses a symlink pointing outside the root', async (ctx) => {
    const server = await start();
    const res = await raw(server, '/link.txt');
    if (res.status === 404) ctx.skip();
    expect(res.status).toBe(403);
    expect(res.body).not.toContain('top secret');
  });

  it('returns 400 for a malformed escape', async () => {
    const server = await start();
    expect((await raw(server, '/%E0%A4%A')).status).toBe(400);
  });
});

describe('range requests', () => {
  it('returns 206 with a content-range', async () => {
    const server = await start();
    const res = await raw(server, '/assets/data.bin', { headers: { range: 'bytes=2-5' } });
    expect(res.status).toBe(206);
    expect(res.body).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
  });

  it('supports suffix ranges', async () => {
    const server = await start();
    const res = await raw(server, '/assets/data.bin', { headers: { range: 'bytes=-3' } });
    expect(res.status).toBe(206);
    expect(res.body).toBe('789');
  });

  it('returns 416 when the range is outside the file', async () => {
    const server = await start();
    const res = await raw(server, '/assets/data.bin', { headers: { range: 'bytes=50-60' } });
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */10');
  });

  it('ignores Range when ranges are off', async () => {
    const server = await start({ ranges: false });
    const res = await raw(server, '/assets/data.bin', { headers: { range: 'bytes=2-5' } });
    expect(res.status).toBe(200);
    expect(res.body).toBe('0123456789');
    expect(res.headers['accept-ranges']).toBeUndefined();
  });
});

describe('not found and SPA fallback', () => {
  it('returns 404 text by default', async () => {
    const server = await start();
    const res = await raw(server, '/missing');
    expect(res.status).toBe(404);
    expect(res.body).toBe('Not found\n');
  });

  it('sends the not-found file with status 404', async () => {
    const server = await start({ notFoundFile: '404.html' });
    const res = await raw(server, '/missing');
    expect(res.status).toBe(404);
    expect(res.body).toBe('<h1>missing page</h1>');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('falls back to index.html for extensionless paths only', async () => {
    const server = await start({ spaFallback: true });
    const route = await raw(server, '/settings/profile');
    expect(route.status).toBe(200);
    expect(route.body).toBe('<h1>home</h1>');
    expect((await raw(server, '/assets/missing.js')).status).toBe(404);
  });

  it('keeps excluded prefixes out of the fallback', async () => {
    const server = await start({ spaFallback: { exclude: ['/api'] } });
    expect((await raw(server, '/api/users')).status).toBe(404);
    expect((await raw(server, '/api')).status).toBe(404);
    expect((await raw(server, '/apiary')).status).toBe(200);
  });

  it('does not fall back when spaFallback is off', async () => {
    const server = await start();
    expect((await raw(server, '/settings')).status).toBe(404);
  });
});

describe('clean URLs', () => {
  it('tries .html and /index.html', async () => {
    const server = await start({ cleanUrls: true });
    expect((await raw(server, '/about')).body).toBe('<h1>about</h1>');
    expect((await raw(server, '/docs/')).body).toBe('<h1>docs</h1>');
    expect((await raw(server, '/nothing')).status).toBe(404);
  });
});

describe('options', () => {
  it('blocks dot segments when asked', async () => {
    const open = await start();
    expect((await raw(open, '/.hidden/x.txt')).body).toBe('hidden');
    const closed = await start({ blockDotfiles: true });
    expect((await raw(closed, '/.hidden/x.txt')).status).toBe(404);
  });

  it('serves under a base path', async () => {
    const server = await start({ basePath: 'docs/' });
    expect((await raw(server, '/docs/about.html')).body).toBe('<h1>about</h1>');
    expect((await raw(server, '/docs')).headers.location).toBe('/docs/');
    expect((await raw(server, '/about.html')).status).toBe(404);
  });

  it('checks the Host header against allowedHosts', async () => {
    const server = await start({ allowedHosts: ['example.test', '127.0.0.1'] });
    expect((await raw(server, '/', { headers: { host: 'example.test:1234' } })).status).toBe(200);
    expect((await raw(server, '/', { headers: { host: 'evil.test' } })).status).toBe(403);
  });

  it('applies cache control, headers and extra MIME types', async () => {
    const server = await start({
      cacheControl: (urlPath) => (urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store'),
      headers: (file) => ({ 'x-file': path.basename(file), 'x-content-type-options': 'nosniff' }),
      mime: { '.glb': 'model/gltf-binary' },
    });
    const asset = await raw(server, '/assets/model.glb');
    expect(asset.headers['content-type']).toBe('model/gltf-binary');
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['x-file']).toBe('model.glb');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect((await raw(server, '/')).headers['cache-control']).toBe('no-store');
  });

  it('accepts a plain header map', async () => {
    const server = await start({ headers: { 'x-robots-tag': 'noindex' } });
    expect((await raw(server, '/')).headers['x-robots-tag']).toBe('noindex');
  });

  it('reports each request to onRequest', async () => {
    log.length = 0;
    const server = await start({ spaFallback: true, onRequest: (entry) => log.push(entry) });
    await raw(server, '/about.html');
    await raw(server, '/docs/');
    await raw(server, '/route');
    await raw(server, '/missing.js');
    await raw(server, '/', { method: 'DELETE' });
    expect(log.map((entry) => [entry.method, entry.path, entry.status, entry.served])).toEqual([
      ['GET', '/about.html', 200, 'file'],
      ['GET', '/docs/', 200, 'index'],
      ['GET', '/route', 200, 'fallback'],
      ['GET', '/missing.js', 404, 'none'],
      ['DELETE', '/', 405, 'none'],
    ]);
  });

  it('picks a free port and reports the url', async () => {
    const server = await start();
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
  });

  it('rejects when the port is taken', async () => {
    const first = await start();
    await expect(startStaticServer({ root: site, port: first.port })).rejects.toThrow();
  });
});
