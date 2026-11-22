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

To use your own server, or to answer some routes yourself first, build a handler:

```ts
import { createServer } from 'node:http';
import { createStaticHandler } from '@uppercut-labs/static-file-server';

const handle = createStaticHandler({ root: './dist', cleanUrls: true });
createServer((req, res) => void handle(req, res)).listen(3000);
```

Stub routes, test controls and extra folders fit in two options:

```ts
const site = await startStaticServer({
  root: './dist',
  cleanUrls: true,
  // Answer a request yourself: return true when you did.
  before: (req, res) => {
    if (req.url === '/api/contact') {
      res.writeHead(405).end('disabled');
      return true;
    }
    return false;
  },
  // Serve another folder under a URL prefix.
  mounts: { '/media': './media-files' },
});
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
| `cleanUrls` | `false` | Try `<path>.html` and `<path>/index.html`. When a folder and a `<path>.html` page share a name, the page is served (as in a static export) |
| `ranges` | `true` | Answer `Range` requests with 206 and 416 |
| `cacheControl` | `no-cache` | A string, or a function of the URL path |
| `headers` | none | Extra response headers, or a function of the file path |
| `mime` | none | Extra content types by extension |
| `notFoundFile` | none | File sent with 404 responses |
| `blockDotfiles` | `false` | 404 for any path segment that starts with a dot |
| `basePath` | none | URL prefix the site is served under |
| `allowedHosts` | any | Accepted `Host` names; others get 403 |
| `onRequest` | none | Called with `{ method, path, status, served }` for each request |
| `before` | none | `(request, response) => boolean \| Promise<boolean>`, called after the `allowedHosts` check. Return `true` when the hook answered the request; anything else lets it continue. Handled requests are not reported to `onRequest`. A throw becomes a 500 |
| `mounts` | none | `{ '/prefix': './folder' }`: serve more folders under URL prefixes with the same guard, ranges, headers and caching. The longest prefix wins, a mount shadows same-named files in `root`, and `spaFallback` never applies to a mount |

Only `GET` and `HEAD` are accepted; other methods get 405. A directory requested without a trailing slash is redirected with 301, and the query string is kept.

Changed in 0.2.0: added `before` and `mounts`; with `cleanUrls`, `<path>.html` is now served instead of a redirect when a folder has the same name; redirects keep the query string (0.1.0 dropped it).

Command line flags: `--port`, `--host`, `--spa`, `--clean-urls`, `--no-ranges`, `--cache`, `--dotfiles`. Paths with dot segments are hidden unless `--dotfiles` is given.

## Errors

`startStaticServer` rejects if the port cannot be bound. Requests never throw: bad paths get 400, paths outside the root get 403, and read failures get 500.

## License

MIT
