/**
 * Read a Request or Response body without ever buffering more than a byte limit.
 * Works anywhere the Fetch API exists: Cloudflare Workers, Deno, Bun, browsers and Node 18+.
 */

export type BodyErrorCode =
  | 'body_too_large'
  | 'invalid_content_length'
  | 'missing_body'
  | 'unsupported_media_type'
  | 'unsupported_content_encoding'
  | 'invalid_utf8'
  | 'invalid_json';

const STATUS: Record<BodyErrorCode, 400 | 413 | 415> = {
  body_too_large: 413,
  invalid_content_length: 400,
  missing_body: 400,
  unsupported_media_type: 415,
  unsupported_content_encoding: 415,
  invalid_utf8: 400,
  invalid_json: 400,
};

/** Thrown for every rejected body. `status` is the HTTP status a server would normally answer with. */
export class BodyError extends Error {
  readonly code: BodyErrorCode;
  readonly status: 400 | 413 | 415;
  readonly maxBytes?: number;

  constructor(code: BodyErrorCode, maxBytes?: number) {
    super(code);
    this.name = 'BodyError';
    this.code = code;
    this.status = STATUS[code];
    this.maxBytes = maxBytes;
  }
}

export interface ReadBodyOptions {
  /** Largest body accepted, in bytes. Reading stops and the stream is cancelled as soon as it is exceeded. */
  maxBytes: number;
  /** When the body is absent: return an empty result (default) or throw `missing_body`. */
  allowMissing?: boolean;
  /** Reject a Content-Length header that is malformed or larger than `maxBytes` before reading. Default true. */
  checkContentLength?: boolean;
  /** Required media type, compared without parameters (e.g. "application/json"). Default: no check. */
  requireContentType?: string;
  /** Reject bodies with a Content-Encoding other than identity. Default false. */
  requireIdentityEncoding?: boolean;
  /** Build your own error instead of throwing `BodyError` (for example an HTTP error your framework knows). */
  toError?: (error: BodyError) => unknown;
}

export interface ReadJsonOptions extends Omit<ReadBodyOptions, 'requireContentType'> {
  /** Required media type. Default "application/json"; pass null to skip the check. */
  requireContentType?: string | null;
}

type Source = Request | Response;

function fail(code: BodyErrorCode, opts: ReadBodyOptions): never {
  const error = new BodyError(code, code === 'body_too_large' ? opts.maxBytes : undefined);
  throw opts.toError ? opts.toError(error) : error;
}

function mediaType(value: string | null): string | null {
  if (!value) return null;
  return value.split(';')[0]!.trim().toLowerCase();
}

function checkHeaders(src: Source, opts: ReadBodyOptions): void {
  if (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0) {
    throw new RangeError('maxBytes must be a non-negative safe integer');
  }
  const headers = src.headers;
  if (opts.requireContentType && mediaType(headers.get('content-type')) !== opts.requireContentType.toLowerCase()) {
    fail('unsupported_media_type', opts);
  }
  if (opts.requireIdentityEncoding) {
    const encoding = headers.get('content-encoding');
    if (encoding && encoding.trim().toLowerCase() !== 'identity') fail('unsupported_content_encoding', opts);
  }
  if (opts.checkContentLength !== false) {
    const length = headers.get('content-length');
    if (length !== null) {
      if (!/^\d+$/.test(length.trim())) fail('invalid_content_length', opts);
      if (Number(length) > opts.maxBytes) fail('body_too_large', opts);
    }
  }
}

/** Read the body as bytes, up to `maxBytes`. */
export async function readBodyBytes(src: Source, opts: ReadBodyOptions): Promise<Uint8Array> {
  checkHeaders(src, opts);
  if (!src.body) {
    if (opts.allowMissing === false) fail('missing_body', opts);
    return new Uint8Array(0);
  }
  const reader = src.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > opts.maxBytes) {
        await reader.cancel().catch(() => undefined);
        fail('body_too_large', opts);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0 && opts.allowMissing === false) fail('missing_body', opts);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Read the body as UTF-8 text, up to `maxBytes`. Invalid UTF-8 is rejected, never replaced. */
export async function readBodyText(src: Source, opts: ReadBodyOptions): Promise<string> {
  const bytes = await readBodyBytes(src, opts);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return fail('invalid_utf8', opts);
  }
}

/** Read and parse a JSON body, up to `maxBytes`. Requires Content-Type application/json unless told otherwise. */
export async function readBodyJson<T = unknown>(src: Source, opts: ReadJsonOptions): Promise<T> {
  const requireContentType = opts.requireContentType === undefined ? 'application/json' : opts.requireContentType ?? undefined;
  const textOpts: ReadBodyOptions = { ...opts, requireContentType };
  const text = await readBodyText(src, textOpts);
  try {
    return JSON.parse(text) as T;
  } catch {
    return fail('invalid_json', textOpts);
  }
}
