# @uppercut-labs/security-headers

Build a Content-Security-Policy from a directive map, derive per-route policies from one base, set the usual security headers on a `Response`, and edit a Cloudflare Pages `_headers` file. No dependencies. It runs in Cloudflare Workers, Deno, Bun, browsers and Node 18+.

```sh
npm install @uppercut-labs/security-headers
```

```ts
import { applySecurityHeaders, buildCsp, cspOrigin, extendCsp } from '@uppercut-labs/security-headers';

const app = {
  'default-src': "'none'",
  'script-src': "'self'",
  'style-src': "'self'",
  'img-src': "'self'",
  'connect-src': ["'self'", cspOrigin(env.API_BASE_URL)], // blank adds nothing
  'base-uri': "'none'",
  'frame-ancestors': "'none'",
};
const withCovers = extendCsp(app, { 'img-src': 'https://img.example.test', 'frame-src': 'https://player.example.test' });

export default {
  async fetch(request: Request, env: Env) {
    const response = await handle(request, env);
    return applySecurityHeaders(response, { csp: buildCsp(isMediaPage(request) ? withCovers : app) });
  },
};
```

## Policies

- `buildCsp(directives)`: `{ 'img-src': ["'self'", 'data:'] }` becomes `img-src 'self' data:`. Directives keep the order written. A string source is split on spaces and duplicates are dropped. `true` writes a bare directive (`upgrade-insecure-requests`); `false`, `null` and `undefined` leave a directive out. A source containing `;`, `,`, whitespace or a control character throws `SecurityHeadersError`, so a configured value cannot end a directive or add a second policy.
- `extendCsp(base, additions)`: add sources to a base policy (a directive map or a policy string). Each addition is appended to the same directive or added when the base has none; `'none'` is dropped from a directive that gains sources. Returns a directive map for `buildCsp`.
- `parseCsp(policy)`: a policy string as `{ directive: sources[] }`. Names are lower-cased and the first of a repeated directive wins, as in browsers.
- `cspOrigin(url)`: the origin of an http(s) URL for use as a source. A blank value gives `''`; anything else that is not a URL throws.
- `escapeCspSource(url)`: percent-encodes `;`, `,` and whitespace in a URL you must use as a source.

## Response headers

`securityHeaders(options)` returns the headers as an object; `applySecurityHeaders(response, options, { overwrite? })` returns a copy of the response with them set, passing status, status text and body through. A header the response already has is kept unless `overwrite` is true, so a route's own page policy survives.

| Option | Default | Meaning |
| --- | --- | --- |
| `csp` | none | Policy string or directive map; `false` for none |
| `contentTypeOptions` | `nosniff` | `false` to omit |
| `referrerPolicy` | `no-referrer` | A value, or `false` to omit |
| `permissionsPolicy` | `camera=(), microphone=(), geolocation=()` | A string, or `{ camera: [], fullscreen: ['self'] }`, or `false` |
| `frameOptions` | `DENY` | `'SAMEORIGIN'`, or `false` for a site that relies on `frame-ancestors` |
| `hsts` | off | `{ maxAgeSeconds, includeSubDomains?, preload? }`; set it only for a host that is HTTPS-only |
| `crossOriginOpenerPolicy`, `crossOriginResourcePolicy` | off | Any value |
| `extra` | none | Other headers, set as given |

A value that could not be sent in a header (a line break, a non-ASCII character) throws.

## `_headers` files

```ts
import { buildHeadersFile, setHeaderInHeadersFile } from '@uppercut-labs/security-headers';

await writeFile('dist/_headers', buildHeadersFile([
  { path: '/*', headers: { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': buildCsp(app) } },
  { path: '/assets/*', headers: { 'Cache-Control': 'public, max-age=31536000, immutable' } },
]));

// At build time, swap one value in a file the framework already wrote:
const text = await readFile('dist/_headers', 'utf8');
await writeFile('dist/_headers', setHeaderInHeadersFile(text, 'Content-Security-Policy', policy));
```

`setHeaderInHeadersFile(text, name, value, { path? })` replaces the header in every rule, or only the rule for `path`, matching names without regard to case. It throws when the header is not there, so a build cannot quietly ship a file without it. Path lines, names and values may not contain a line break.

## Tests

The suite runs reference copies of the policy builders, header wrapper and `_headers` rewrite step this package replaces, with synthetic origins, and compares their output byte for byte; where it differs from a hand-spliced string (directive order in one derived policy) it compares the parsed sources instead.

## License

MIT
