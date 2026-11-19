import { describe, expect, it, vi } from 'vitest';
import { generateServiceWorker, runCli, ShellServiceWorkerError, type ShellServiceWorkerOptions } from '../src/index.js';

type Handler = (event: any) => void;

class MemoryCache {
  store = new Map<string, Response>();
  key(request: Request | string, ignoreSearch?: boolean) {
    const url = new URL(typeof request === 'string' ? request : request.url, 'https://app.test');
    if (ignoreSearch) url.search = '';
    return url.href;
  }
  async addAll(urls: string[]) {
    for (const url of urls) {
      const response = await (globalThis as any).__fetch(new Request(new URL(url, 'https://app.test')));
      if (!response.ok) throw new Error(`precache failed: ${url}`);
      this.store.set(this.key(url), response);
    }
  }
  async match(request: Request | string, options?: { ignoreSearch?: boolean }) {
    const wanted = this.key(request, options?.ignoreSearch);
    for (const [k, v] of this.store) {
      if (this.key(k, options?.ignoreSearch) === wanted) return v.clone();
    }
    return undefined;
  }
  async put(request: Request, response: Response) {
    this.store.set(this.key(request), response);
  }
}

/** Runs the generated script against fake service worker globals. */
function load(options: ShellServiceWorkerOptions, network: (request: Request) => Promise<Response>) {
  const handlers: Record<string, Handler> = {};
  const caches = new Map<string, MemoryCache>();
  const cachesApi = {
    open: async (name: string) => {
      if (!caches.has(name)) caches.set(name, new MemoryCache());
      return caches.get(name)!;
    },
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  };
  const skipWaiting = vi.fn(async () => {});
  const claim = vi.fn(async () => {});
  const self = {
    addEventListener: (type: string, fn: Handler) => {
      handlers[type] = fn;
    },
    location: { origin: 'https://app.test' },
    skipWaiting,
    clients: { claim },
  };
  (globalThis as any).__fetch = network;
  const fetchFn = (request: Request) => network(request);
  new Function('self', 'caches', 'fetch', generateServiceWorker(options))(self, cachesApi, fetchFn);

  async function lifecycle(type: 'install' | 'activate') {
    const waits: Promise<unknown>[] = [];
    handlers[type]({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
  }

  async function fetchEvent(request: Request) {
    let responded: Promise<Response> | undefined;
    const waits: Promise<unknown>[] = [];
    handlers.fetch({
      request,
      respondWith: (p: Promise<Response>) => {
        responded = p;
      },
      waitUntil: (p: Promise<unknown>) => waits.push(p),
    });
    const response = responded ? await responded : undefined;
    await Promise.all(waits);
    return response;
  }

  return { handlers, caches, skipWaiting, claim, lifecycle, fetchEvent };
}

function req(path: string, init: RequestInit & { mode?: RequestMode; destination?: string } = {}) {
  const { mode, destination: _d, ...rest } = init;
  const request = new Request(`https://app.test${path}`, rest);
  if (mode === 'navigate') Object.defineProperty(request, 'mode', { value: 'navigate' });
  if (init.destination) Object.defineProperty(request, 'destination', { value: init.destination });
  return request;
}

const ok = (body = 'ok') => new Response(body, { status: 200 });
const down = async () => {
  throw new TypeError('network down');
};

describe('generateServiceWorker validation', () => {
  it('requires a cache name', () => {
    expect(() => generateServiceWorker({} as never)).toThrow(ShellServiceWorkerError);
    expect(() => generateServiceWorker({ cacheName: ' ' })).toThrow(/cacheName/);
  });

  it('rejects bad option values', () => {
    expect(() => generateServiceWorker({ cacheName: 'a', precache: ['ok', ''] })).toThrow(/precache/);
    expect(() => generateServiceWorker({ cacheName: 'a', navigationStrategy: 'x' as never })).toThrow(/navigationStrategy/);
    expect(() => generateServiceWorker({ cacheName: 'a', assetStrategy: 'x' as never })).toThrow(/assetStrategy/);
    expect(() => generateServiceWorker({ cacheName: 'a', skipWaiting: 'x' as never })).toThrow(/skipWaiting/);
    expect(() => generateServiceWorker({ cacheName: 'a', cleanup: 'x' as never })).toThrow(/cleanup/);
    expect(() => generateServiceWorker({ cacheName: 'a', ignoreSearch: 'yes' as never })).toThrow(/ignoreSearch/);
    expect(() => generateServiceWorker({ cacheName: 'a', version: '' })).toThrow(/version/);
    expect(() => generateServiceWorker({ cacheName: 'a', navigationFallback: '' })).toThrow(/navigationFallback/);
  });

  it('produces parseable JavaScript with the options embedded', () => {
    const script = generateServiceWorker({ cacheName: 'my-app', version: 'v3', precache: ['/', '/app.js'] });
    expect(() => new Function('self', 'caches', 'fetch', script)).not.toThrow();
    expect(script).toContain('"cache": "my-app-v3"');
    expect(script).toContain('"/app.js"');
  });

  it('is safe against option values that look like code', () => {
    const nasty = '"; throw new Error("x"); //';
    const script = generateServiceWorker({ cacheName: nasty });
    expect(() => new Function('self', 'caches', 'fetch', script)).not.toThrow();
    const handlers: Record<string, Handler> = {};
    new Function('self', 'caches', 'fetch', script)({ addEventListener: (t: string, f: Handler) => (handlers[t] = f) }, {}, () => {});
    expect(Object.keys(handlers)).toContain('fetch');
  });
});

describe('install and activate', () => {
  it('precaches the shell and skips waiting immediately by default', async () => {
    const sw = load({ cacheName: 'app', version: '1', precache: ['/', '/app.js'] }, async () => ok());
    await sw.lifecycle('install');
    expect([...sw.caches.get('app-1')!.store.keys()].sort()).toEqual(['https://app.test/', 'https://app.test/app.js']);
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
  });

  it('fails installation when a precache request fails', async () => {
    const sw = load({ cacheName: 'app', precache: ['/missing'] }, async () => new Response('', { status: 404 }));
    await expect(sw.lifecycle('install')).rejects.toThrow(/precache failed/);
    expect(sw.skipWaiting).not.toHaveBeenCalled();
  });

  it('waits for a message in message mode', async () => {
    const sw = load({ cacheName: 'app', skipWaiting: 'message', precache: ['/'] }, async () => ok());
    await sw.lifecycle('install');
    expect(sw.skipWaiting).not.toHaveBeenCalled();
    sw.handlers.message({ data: { type: 'SKIP_WAITING' } });
    expect(sw.skipWaiting).toHaveBeenCalledTimes(1);
    sw.handlers.message({ data: 'SKIP_WAITING' });
    expect(sw.skipWaiting).toHaveBeenCalledTimes(2);
    sw.handlers.message({ data: { type: 'OTHER' } });
    sw.handlers.message({ data: null });
    expect(sw.skipWaiting).toHaveBeenCalledTimes(2);
  });

  it('removes older caches with the same prefix and claims clients', async () => {
    const sw = load({ cacheName: 'app', version: '2' }, async () => ok());
    sw.caches.set('app-1', new MemoryCache());
    sw.caches.set('app-2', new MemoryCache());
    sw.caches.set('other', new MemoryCache());
    await sw.lifecycle('activate');
    expect([...sw.caches.keys()].sort()).toEqual(['app-2', 'other']);
    expect(sw.claim).toHaveBeenCalledTimes(1);
  });

  it('cleanup all removes every other cache; cleanupPrefix narrows', async () => {
    const all = load({ cacheName: 'app', cleanup: 'all' }, async () => ok());
    all.caches.set('app', new MemoryCache());
    all.caches.set('other', new MemoryCache());
    await all.lifecycle('activate');
    expect([...all.caches.keys()]).toEqual(['app']);

    const prefixed = load({ cacheName: 'app', version: '2', cleanupPrefix: 'shell-' }, async () => ok());
    prefixed.caches.set('shell-old', new MemoryCache());
    prefixed.caches.set('app-1', new MemoryCache());
    await prefixed.lifecycle('activate');
    expect([...prefixed.caches.keys()]).toEqual(['app-1']);
  });
});

describe('fetch handling', () => {
  const shell = { cacheName: 'app', precache: ['/', '/app.js'] };

  it('ignores non-GET, cross-origin, authorized and bypassed requests', async () => {
    const sw = load({ ...shell, bypassPrefixes: ['/api/'] }, async () => ok());
    expect(await sw.fetchEvent(req('/x', { method: 'POST', body: 'a' }))).toBeUndefined();
    expect(await sw.fetchEvent(new Request('https://elsewhere.test/x'))).toBeUndefined();
    expect(await sw.fetchEvent(req('/x', { headers: { authorization: 'Bearer t' } }))).toBeUndefined();
    expect(await sw.fetchEvent(req('/api/items'))).toBeUndefined();
    expect(await sw.fetchEvent(req('/other'))).toBeDefined();
  });

  it('can stop bypassing authorized requests', async () => {
    const sw = load({ ...shell, bypassAuthorized: false }, async () => ok());
    expect(await sw.fetchEvent(req('/x', { headers: { authorization: 'Bearer t' } }))).toBeDefined();
  });

  it('network-first navigation returns the network response, including errors', async () => {
    const sw = load(shell, async () => new Response('nope', { status: 404 }));
    const response = await sw.fetchEvent(req('/missing', { mode: 'navigate' }));
    expect(response!.status).toBe(404);
  });

  it('network-first navigation falls back to the cached shell only on network error', async () => {
    let online = true;
    const sw = load(shell, async (r) => (online ? ok(`net:${new URL(r.url).pathname}`) : down()));
    await sw.lifecycle('install');
    online = false;
    const response = await sw.fetchEvent(req('/deep/route?x=1', { mode: 'navigate' }));
    expect(await response!.text()).toBe('net:/');
  });

  it('returns 503 when offline with nothing cached', async () => {
    const sw = load(shell, down);
    const response = await sw.fetchEvent(req('/', { mode: 'navigate' }));
    expect(response!.status).toBe(503);
    const asset = await sw.fetchEvent(req('/x.js'));
    expect(asset!.status).toBe(503);
  });

  it('uses a custom navigation fallback', async () => {
    let online = true;
    const sw = load(
      { cacheName: 'app', precache: ['/shell.html'], navigationFallback: '/shell.html' },
      async (r) => (online ? ok(new URL(r.url).pathname) : down()),
    );
    await sw.lifecycle('install');
    online = false;
    expect(await (await sw.fetchEvent(req('/any', { mode: 'navigate' })))!.text()).toBe('/shell.html');
  });

  it('cache-first navigation serves the shell without touching the network', async () => {
    const network = vi.fn(async (r: Request) => ok(new URL(r.url).pathname));
    const sw = load({ ...shell, navigationStrategy: 'cache-first' }, network);
    await sw.lifecycle('install');
    network.mockClear();
    expect(await (await sw.fetchEvent(req('/page', { mode: 'navigate' })))!.text()).toBe('/');
    expect(network).not.toHaveBeenCalled();
  });

  it('only handles allowlisted navigations when an allowlist is set', async () => {
    const sw = load({ ...shell, navigationAllowlist: ['/', '/settings'] }, async () => ok());
    expect(await sw.fetchEvent(req('/settings', { mode: 'navigate' }))).toBeDefined();
    expect(await sw.fetchEvent(req('/auth/callback', { mode: 'navigate' }))).toBeUndefined();
  });

  it('cache-first assets: serves cache, ignores the query, stores new ok responses', async () => {
    const network = vi.fn(async (r: Request) => ok(new URL(r.url).pathname === '/new.css' ? 'fresh' : 'precached'));
    const sw = load(shell, network);
    await sw.lifecycle('install');
    network.mockClear();
    expect(await (await sw.fetchEvent(req('/app.js?v=2')))!.text()).toBe('precached');
    expect(network).not.toHaveBeenCalled();

    expect(await (await sw.fetchEvent(req('/new.css')))!.text()).toBe('fresh');
    expect(sw.caches.get('app')!.store.has('https://app.test/new.css')).toBe(true);
  });

  it('respects ignoreSearch: false', async () => {
    const network = vi.fn(async () => ok('fresh'));
    const sw = load({ ...shell, ignoreSearch: false }, network);
    await sw.lifecycle('install');
    network.mockClear();
    expect(await (await sw.fetchEvent(req('/app.js?v=2')))!.text()).toBe('fresh');
  });

  it('does not store failed responses, nor when runtimeCache is off', async () => {
    const failing = load(shell, async () => new Response('x', { status: 500 }));
    await failing.fetchEvent(req('/bad.js'));
    expect(failing.caches.get('app')?.store.has('https://app.test/bad.js') ?? false).toBe(false);

    const off = load({ ...shell, runtimeCache: false }, async () => ok());
    await off.fetchEvent(req('/good.js'));
    expect(off.caches.get('app')?.store.has('https://app.test/good.js') ?? false).toBe(false);
  });

  it('stores only chosen destinations at runtime', async () => {
    const sw = load({ ...shell, runtimeDestinations: ['script', 'style'] }, async () => ok());
    await sw.fetchEvent(req('/a.js', { destination: 'script' }));
    await sw.fetchEvent(req('/photo.png', { destination: 'image' }));
    const keys = [...(sw.caches.get('app')?.store.keys() ?? [])];
    expect(keys).toContain('https://app.test/a.js');
    expect(keys).not.toContain('https://app.test/photo.png');
  });

  it('network-first assets use the network, store it, and fall back to the cache offline', async () => {
    let online = true;
    let body = 'v1';
    const sw = load({ ...shell, assetStrategy: 'network-first' }, async () => (online ? ok(body) : down()));
    expect(await (await sw.fetchEvent(req('/data.json')))!.text()).toBe('v1');
    body = 'v2';
    expect(await (await sw.fetchEvent(req('/data.json')))!.text()).toBe('v2');
    online = false;
    expect(await (await sw.fetchEvent(req('/data.json')))!.text()).toBe('v2');
    expect((await sw.fetchEvent(req('/never-seen.json')))!.status).toBe(503);
  });
});

describe('runCli', () => {
  function io(files: Record<string, string> = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const written: Record<string, string> = {};
    return {
      out,
      err,
      written,
      io: {
        readFile: (path: string) => {
          if (!(path in files)) throw new Error(`no such file: ${path}`);
          return files[path];
        },
        writeFile: (path: string, content: string) => {
          written[path] = content;
        },
        stdout: (t: string) => out.push(t),
        stderr: (t: string) => err.push(t),
      },
    };
  }

  it('prints a script to stdout from flags', () => {
    const t = io();
    const code = runCli(['--cache-name', 'my-app', '--precache', '/,/app.js', '--precache', '/styles.css', '--version', '4'], t.io);
    expect(code).toBe(0);
    const script = t.out.join('');
    expect(script).toContain('"cache": "my-app-4"');
    expect(script).toContain('"/styles.css"');
    expect(script).toContain('"/app.js"');
  });

  it('writes to --out and reads --config, with flags overriding', () => {
    const t = io({ 'sw.json': JSON.stringify({ cacheName: 'from-file', navigationStrategy: 'cache-first' }) });
    const code = runCli(['--config', 'sw.json', '--out', 'dist/sw.js', '--cache-name', 'from-flag', '--no-ignore-search', '--bypass-prefix', '/api/'], t.io);
    expect(code).toBe(0);
    expect(t.out).toEqual([]);
    const script = t.written['dist/sw.js'];
    expect(script).toContain('"cache": "from-flag"');
    expect(script).toContain('"navigationStrategy": "cache-first"');
    expect(script).toContain('"ignoreSearch": false');
    expect(script).toContain('"/api/"');
  });

  it('shows help', () => {
    const t = io();
    expect(runCli(['--help'], t.io)).toBe(0);
    expect(t.out.join('')).toContain('Usage:');
  });

  it('exits 2 on unknown flags and missing values', () => {
    expect(runCli(['--nope'], io().io)).toBe(2);
    const t = io();
    expect(runCli(['--cache-name'], t.io)).toBe(2);
    expect(t.err.join('')).toContain('Missing value');
    expect(runCli(['--cache-name', '--out'], io().io)).toBe(2);
  });

  it('exits 1 on invalid options, bad JSON and missing files', () => {
    const t = io();
    expect(runCli([], t.io)).toBe(1);
    expect(t.err.join('')).toContain('cacheName');
    expect(runCli(['--cache-name', 'a', '--skip-waiting', 'sometimes'], io().io)).toBe(1);
    expect(runCli(['--config', 'bad.json'], io({ 'bad.json': '{nope' }).io)).toBe(1);
    expect(runCli(['--config', 'arr.json'], io({ 'arr.json': '[]' }).io)).toBe(1);
    expect(runCli(['--config', 'missing.json'], io().io)).toBe(1);
  });
});
