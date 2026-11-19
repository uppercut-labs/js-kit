# @uppercut-labs/static-file-server

Serves a folder over HTTP from Node with no dependencies. It rejects path traversal (including encoded dots and symlinks that leave the folder), sends the right content type, answers range requests so video can seek, and can fall back to `index.html` for client-side routes. It works as a function you call from code and as a small command line tool.

```sh
npm install @uppercut-labs/static-file-server
```

```ts
import { startStaticServer } from '@uppercut-labs/static-file-server';

const site = await startStaticServer({ root: './dist', spaFallback: true });
console.log(site.url); // http://127.0.0.1:<free port>
// ...
await site.close();
```

To use your own server, build a handler:

```ts
import { createServer } from 'node:http';
import { createStaticHandler } from '@uppercut-labs/static-file-server';

const handle = createStaticHandler({ root: './dist', cleanUrls: true });
createServer((req, res) => void handle(req, res)).listen(3000);
```

Command line:

```sh
npx static-file-server ./dist --port 8080 --spa
```

## Functions

| Function | Returns |
| --- | --- |
| `startStaticServer(options)` | `Promise<{ server, host, port, url, close() }>`, listening |
| `createStaticServer(options)` | an `http.Server`, not yet listening |
| `createStaticHandler(options)` | `(request, response) => Promise<void>` |
| `resolveStaticPath(root, urlPath)` | `{ ok: true, file, isDirectory }` or `{ ok: false, problem }` where `problem` is `bad-request`, `forbidden` or `not-found` |
| `parseRange(header, size)` | `{ start, end }`, `'unsatisfiable'`, or `null` to send the whole file |
| `contentTypeFor(file, extra?)` | content type string |
| `MIME_TYPES` | the built-in extension table |

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `root` | required | Folder to serve |
| `port` | `0` | Port for `startStaticServer`; 0 picks a free one |
| `host` | `127.0.0.1` | Interface for `startStaticServer` |
| `index` | `index.html` | Index file name |
| `spaFallback` | `false` | Send the index file for unknown paths without an extension. `{ exclude: ['/api'] }` keeps prefixes out |
| `cleanUrls` | `false` | Try `<path>.html` and `<path>/index.html` |
| `ranges` | `true` | Answer `Range` requests with 206 and 416 |
| `cacheControl` | `no-cache` | A string, or a function of the URL path |
| `headers` | none | Extra response headers, or a function of the file path |
| `mime` | none | Extra content types by extension |
| `notFoundFile` | none | File sent with 404 responses |
| `blockDotfiles` | `false` | 404 for any path segment that starts with a dot |
| `basePath` | none | URL prefix the site is served under |
| `allowedHosts` | any | Accepted `Host` names; others get 403 |
| `onRequest` | none | Called with `{ method, path, status, served }` for each request |

Only `GET` and `HEAD` are accepted; other methods get 405. A directory requested without a trailing slash is redirected with 301.

Command line flags: `--port`, `--host`, `--spa`, `--clean-urls`, `--no-ranges`, `--cache`, `--dotfiles`. Paths with dot segments are hidden unless `--dotfiles` is given.

## Errors

`startStaticServer` rejects if the port cannot be bound. Requests never throw: bad paths get 400, paths outside the root get 403, and read failures get 500.

## License

MIT
