# @uppercut-labs/read-body-with-size-limit

Reads a fetch `Request` or `Response` body as bytes, text or JSON, and never holds more than a byte limit in memory. Reading stops and the stream is cancelled as soon as the limit is passed. Works in Cloudflare Workers, Deno, Bun, browsers and Node 18+.

```sh
npm install @uppercut-labs/read-body-with-size-limit
```

```ts
import { BodyError, readBodyJson } from '@uppercut-labs/read-body-with-size-limit';

export default {
  async fetch(request: Request) {
    try {
      const body = await readBodyJson<{ name: string }>(request, { maxBytes: 64 * 1024 });
      return Response.json({ hello: body.name });
    } catch (error) {
      if (error instanceof BodyError) return Response.json({ error: error.code }, { status: error.status });
      throw error;
    }
  },
};
```

## Functions

| Function | Returns |
| --- | --- |
| `readBodyBytes(source, options)` | `Uint8Array` |
| `readBodyText(source, options)` | `string`, decoded as strict UTF-8 |
| `readBodyJson(source, options)` | the parsed value; requires `Content-Type: application/json` unless `requireContentType` is `null` |

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `maxBytes` | required | Largest body accepted, in bytes |
| `allowMissing` | `true` | An absent or empty body returns an empty result; `false` throws `missing_body` |
| `checkContentLength` | `true` | Reject a malformed or too-large `Content-Length` before reading |
| `requireContentType` | none (`application/json` for `readBodyJson`) | Media type the body must declare, parameters ignored |
| `requireIdentityEncoding` | `false` | Reject bodies sent with a `Content-Encoding` such as gzip |
| `toError` | none | Turn a `BodyError` into your own error type before it is thrown |

## Errors

Every rejection throws a `BodyError` with a `code` and the matching HTTP `status`:

| Code | Status |
| --- | --- |
| `body_too_large` | 413 |
| `invalid_content_length` | 400 |
| `missing_body` | 400 |
| `unsupported_media_type` | 415 |
| `unsupported_content_encoding` | 415 |
| `invalid_utf8` | 400 |
| `invalid_json` | 400 |

## License

MIT
