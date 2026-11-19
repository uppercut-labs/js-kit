export interface ShellServiceWorkerOptions {
  /** Base name of the cache. Required. */
  cacheName: string;
  /** Appended to the cache name (`name-version`). Change it to make clients fetch a fresh shell. */
  version?: string;
  /** URLs fetched and stored when the worker installs. Installation fails if any of them fails. */
  precache?: string[];
  /** Cached page served for navigations that cannot reach the network. Default `/`. */
  navigationFallback?: string;
  /**
   * `network-first` (default): navigations go to the network, and only a network error falls back to the cache,
   * so a real 404 from the host is never hidden. `cache-first`: serve the cached page, then the network.
   */
  navigationStrategy?: 'network-first' | 'cache-first';
  /** Other same-origin GET requests. `cache-first` (default) or `network-first` with cache fallback. */
  assetStrategy?: 'cache-first' | 'network-first';
  /** Requests whose path starts with one of these are left to the browser, for example `/api/`. */
  bypassPrefixes?: string[];
  /** Leave requests that carry an Authorization header to the browser. Default true. */
  bypassAuthorized?: boolean;
  /** If set, only navigations to exactly these paths are handled. Others go to the browser. */
  navigationAllowlist?: string[];
  /** Ignore the query string when matching cached responses. Default true. */
  ignoreSearch?: boolean;
  /** Store successful responses fetched at runtime. Default true. */
  runtimeCache?: boolean;
  /** If set, only responses for these request destinations (`script`, `style`, `image`, `font`, ...) are stored at runtime. */
  runtimeDestinations?: string[];
  /** Which old caches the activate step deletes. `prefix` (default): names starting with `cleanupPrefix`. `all`: every other cache. */
  cleanup?: 'prefix' | 'all';
  /** Default: `cacheName`. */
  cleanupPrefix?: string;
  /**
   * `immediate` (default): the new worker takes over as soon as it installs.
   * `message`: it waits until the page sends `{ type: 'SKIP_WAITING' }`.
   */
  skipWaiting?: 'immediate' | 'message';
}

export class ShellServiceWorkerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellServiceWorkerError';
  }
}

interface Resolved {
  cache: string;
  precache: string[];
  navigationFallback: string;
  navigationStrategy: 'network-first' | 'cache-first';
  assetStrategy: 'cache-first' | 'network-first';
  bypassPrefixes: string[];
  bypassAuthorized: boolean;
  navigationAllowlist: string[] | null;
  ignoreSearch: boolean;
  runtimeCache: boolean;
  runtimeDestinations: string[] | null;
  cleanup: 'prefix' | 'all';
  cleanupPrefix: string;
  skipWaiting: 'immediate' | 'message';
}

function stringList(name: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) {
    throw new ShellServiceWorkerError(`${name} must be an array of non-empty strings`);
  }
  return [...value];
}

function oneOf<T extends string>(name: string, value: unknown, allowed: readonly T[], fallback: T): T {
  if (value === undefined) return fallback;
  if (!allowed.includes(value as T)) {
    throw new ShellServiceWorkerError(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

function flag(name: string, value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new ShellServiceWorkerError(`${name} must be a boolean`);
  return value;
}

/** Validates options and applies defaults. Throws `ShellServiceWorkerError` on bad input. */
export function resolveOptions(options: ShellServiceWorkerOptions): Resolved {
  if (!options || typeof options !== 'object') throw new ShellServiceWorkerError('options must be an object');
  const { cacheName, version } = options;
  if (typeof cacheName !== 'string' || cacheName.trim() === '') {
    throw new ShellServiceWorkerError('cacheName must be a non-empty string');
  }
  if (version !== undefined && (typeof version !== 'string' || version === '')) {
    throw new ShellServiceWorkerError('version must be a non-empty string');
  }
  const fallback = options.navigationFallback ?? '/';
  if (typeof fallback !== 'string' || fallback === '') {
    throw new ShellServiceWorkerError('navigationFallback must be a non-empty string');
  }
  if (options.cleanupPrefix !== undefined && typeof options.cleanupPrefix !== 'string') {
    throw new ShellServiceWorkerError('cleanupPrefix must be a string');
  }
  return {
    cache: version ? `${cacheName}-${version}` : cacheName,
    precache: options.precache === undefined ? [] : stringList('precache', options.precache),
    navigationFallback: fallback,
    navigationStrategy: oneOf('navigationStrategy', options.navigationStrategy, ['network-first', 'cache-first'], 'network-first'),
    assetStrategy: oneOf('assetStrategy', options.assetStrategy, ['cache-first', 'network-first'], 'cache-first'),
    bypassPrefixes: options.bypassPrefixes === undefined ? [] : stringList('bypassPrefixes', options.bypassPrefixes),
    bypassAuthorized: flag('bypassAuthorized', options.bypassAuthorized, true),
    navigationAllowlist:
      options.navigationAllowlist === undefined ? null : stringList('navigationAllowlist', options.navigationAllowlist),
    ignoreSearch: flag('ignoreSearch', options.ignoreSearch, true),
    runtimeCache: flag('runtimeCache', options.runtimeCache, true),
    runtimeDestinations:
      options.runtimeDestinations === undefined ? null : stringList('runtimeDestinations', options.runtimeDestinations),
    cleanup: oneOf('cleanup', options.cleanup, ['prefix', 'all'], 'prefix'),
    cleanupPrefix: options.cleanupPrefix ?? cacheName,
    skipWaiting: oneOf('skipWaiting', options.skipWaiting, ['immediate', 'message'], 'immediate'),
  };
}

const BODY = `
const CACHE = CONFIG.cache;
const MATCH = { ignoreSearch: CONFIG.ignoreSearch };

function offline() {
  return new Response('Offline', {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

function cached(request) {
  return caches.open(CACHE).then((cache) => cache.match(request, MATCH));
}

function fallbackPage() {
  return cached(CONFIG.navigationFallback);
}

function store(event, request, response) {
  if (!CONFIG.runtimeCache || !response || !response.ok) return;
  if (CONFIG.runtimeDestinations && CONFIG.runtimeDestinations.indexOf(request.destination) === -1) return;
  const copy = response.clone();
  event.waitUntil(caches.open(CACHE).then((cache) => cache.put(request, copy)));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(CONFIG.precache))
      .then(() => (CONFIG.skipWaiting === 'immediate' ? self.skipWaiting() : undefined)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE && (CONFIG.cleanup === 'all' || key.indexOf(CONFIG.cleanupPrefix) === 0))
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data === 'SKIP_WAITING' || (data && data.type === 'SKIP_WAITING')) self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (CONFIG.bypassAuthorized && request.headers.has('authorization')) return;
  if (CONFIG.bypassPrefixes.some((prefix) => url.pathname.indexOf(prefix) === 0)) return;

  if (request.mode === 'navigate') {
    if (CONFIG.navigationAllowlist && CONFIG.navigationAllowlist.indexOf(url.pathname) === -1) return;
    if (CONFIG.navigationStrategy === 'cache-first') {
      event.respondWith(
        fallbackPage().then((page) => page || fetch(request)).catch(offline),
      );
    } else {
      event.respondWith(
        fetch(request).catch(() => fallbackPage().then((page) => page || offline())),
      );
    }
    return;
  }

  if (CONFIG.assetStrategy === 'network-first') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          store(event, request, response);
          return response;
        })
        .catch(() => cached(request).then((hit) => hit || offline())),
    );
    return;
  }

  event.respondWith(
    cached(request).then(
      (hit) =>
        hit ||
        fetch(request).then((response) => {
          store(event, request, response);
          return response;
        }),
    ).catch(offline),
  );
});
`;

/**
 * Returns the source of a service worker that precaches an app shell, removes old caches on activate,
 * serves the shell when the network is unavailable, and leaves cross-origin, non-GET and bypassed requests alone.
 */
export function generateServiceWorker(options: ShellServiceWorkerOptions): string {
  const config = resolveOptions(options);
  const json = JSON.stringify(config, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `// Generated by @uppercut-labs/app-shell-service-worker. Edit the options and regenerate instead of editing this file.\nconst CONFIG = ${json};\n${BODY}`;
}
