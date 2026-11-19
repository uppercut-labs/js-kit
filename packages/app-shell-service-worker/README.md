# @uppercut-labs/app-shell-service-worker

Generates the source of a service worker that precaches an app shell. The worker removes old caches when it activates, serves a cached page when a navigation cannot reach the network, caches other same-origin files, and leaves cross-origin, non-GET and bypassed requests to the browser. Use it as a function in a build script or as a command.

```sh
npm install --save-dev @uppercut-labs/app-shell-service-worker
```

```ts
import { writeFileSync } from 'node:fs';
import { generateServiceWorker } from '@uppercut-labs/app-shell-service-worker';

writeFileSync(
  'dist/sw.js',
  generateServiceWorker({
    cacheName: 'my-app',
    version: '12',
    precache: ['/', '/app.js', '/styles.css', '/manifest.webmanifest'],
    bypassPrefixes: ['/api/'],
    skipWaiting: 'message',
  }),
);
```

Command line:

```sh
npx app-shell-service-worker --cache-name my-app --version 12 \
  --precache /,/app.js,/styles.css --bypass-prefix /api/ --out dist/sw.js
```

The worker must be served from the origin root (or the scope you register it with), so write it into your public output folder.

## generateServiceWorker(options)

Returns the script as a string. Throws `ShellServiceWorkerError` when an option is invalid.

| Option | Default | Meaning |
| --- | --- | --- |
| `cacheName` | required | Base name of the cache |
| `version` | none | Appended as `name-version`; change it to ship a fresh shell |
| `precache` | `[]` | URLs stored at install. If one fails, the install fails and the old worker stays |
| `navigationFallback` | `/` | Cached page served when a navigation cannot reach the network |
| `navigationStrategy` | `network-first` | `network-first` returns whatever the network answers, even a 404, and uses the cache only on a network error. `cache-first` serves the cached page first |
| `assetStrategy` | `cache-first` | For other same-origin GET requests: `cache-first`, or `network-first` with cache fallback |
| `bypassPrefixes` | `[]` | Paths starting with these are left to the browser, such as `/api/` |
| `bypassAuthorized` | `true` | Leave requests with an `Authorization` header to the browser |
| `navigationAllowlist` | none | When set, only navigations to exactly these paths are handled |
| `ignoreSearch` | `true` | Match cached responses without the query string |
| `runtimeCache` | `true` | Store successful responses fetched at runtime |
| `runtimeDestinations` | none | When set, store runtime responses only for these request destinations, such as `script`, `style`, `image`, `font` |
| `cleanup` | `prefix` | On activate, delete other caches whose name starts with `cleanupPrefix` (`prefix`), or every other cache (`all`) |
| `cleanupPrefix` | `cacheName` | Prefix used by `cleanup: 'prefix'` |
| `skipWaiting` | `immediate` | `immediate`: take over as soon as installed. `message`: wait for the page to post `{ type: 'SKIP_WAITING' }` |

When the network fails and nothing is cached, the worker answers `503` with the text `Offline`.

## Command line

`app-shell-service-worker [options]` prints the script to standard output, or to `--out <file>`. Options can come from a JSON file with `--config <file>` using the same names as the function; flags override the file.

| Flag | Option |
| --- | --- |
| `--cache-name`, `--version` | `cacheName`, `version` |
| `--precache <url>[,<url>...]` | `precache` (repeatable) |
| `--navigation-fallback`, `--navigation-strategy`, `--asset-strategy` | the options of the same name |
| `--bypass-prefix <path>` | `bypassPrefixes` (repeatable) |
| `--allow-navigation <path>` | `navigationAllowlist` (repeatable) |
| `--runtime-destination <kind>` | `runtimeDestinations` (repeatable) |
| `--cleanup`, `--cleanup-prefix`, `--skip-waiting` | the options of the same name |
| `--no-ignore-search`, `--no-runtime-cache`, `--no-bypass-authorized` | set that option to `false` |

Exit codes: `0` success, `1` invalid options or an unreadable config file, `2` unknown flag or missing value.

## License

MIT
