import { describe, expect, it } from 'vitest';
import { BodyError, readBodyBytes, readBodyJson, readBodyText } from '../src/index.js';

function req(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request('https://example.test/', { method: 'POST', body, headers, duplex: 'half' } as RequestInit);
}

function streamOf(...parts: string[]) {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of parts) c.enqueue(enc.encode(p));
      c.close();
    },
  });
}

async function code(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    return e instanceof BodyError ? `${e.code}:${e.status}` : String(e);
  }
  return 'ok';
}

describe('readBodyBytes', () => {
  it('returns all bytes under the limit', async () => {
    const out = await readBodyBytes(req('hello'), { maxBytes: 10 });
    expect(new TextDecoder().decode(out)).toBe('hello');
  });

  it('accepts a body exactly at the limit', async () => {
    expect(await code(readBodyBytes(req('12345'), { maxBytes: 5 }))).toBe('ok');
  });

  it('stops a streamed body as soon as it passes the limit', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(new Uint8Array(4));
        if (pulled > 100) c.close();
      },
    });
    expect(await code(readBodyBytes(req(stream), { maxBytes: 10 }))).toBe('body_too_large:413');
    expect(pulled).toBeLessThan(10);
  });

  it('rejects a Content-Length over the limit before reading', async () => {
    const r = req('x', { 'content-length': '999' });
    expect(await code(readBodyBytes(r, { maxBytes: 10 }))).toBe('body_too_large:413');
  });

  it('rejects a malformed Content-Length', async () => {
    const r = new Response('x', { headers: { 'content-length': '12abc' } });
    expect(await code(readBodyBytes(r, { maxBytes: 10 }))).toBe('invalid_content_length:400');
  });

  it('treats a missing body as empty by default and as an error on request', async () => {
    const r = new Request('https://example.test/');
    expect((await readBodyBytes(r, { maxBytes: 10 })).byteLength).toBe(0);
    expect(await code(readBodyBytes(new Request('https://example.test/'), { maxBytes: 10, allowMissing: false }))).toBe('missing_body:400');
  });

  it('rejects encoded bodies when identity is required', async () => {
    const r = req('x', { 'content-encoding': 'gzip' });
    expect(await code(readBodyBytes(r, { maxBytes: 10, requireIdentityEncoding: true }))).toBe('unsupported_content_encoding:415');
  });

  it('works on a Response', async () => {
    const out = await readBodyText(new Response(streamOf('ab', 'cd')), { maxBytes: 4 });
    expect(out).toBe('abcd');
  });

  it('uses toError when given', async () => {
    const err = await readBodyBytes(req('too long'), { maxBytes: 2, toError: (e) => new Error(`custom ${e.status}`) }).catch((e) => e);
    expect(String(err)).toBe('Error: custom 413');
  });
});

describe('readBodyText', () => {
  it('rejects invalid UTF-8', async () => {
    const r = req(new Uint8Array([0xff, 0xfe]));
    expect(await code(readBodyText(r, { maxBytes: 10 }))).toBe('invalid_utf8:400');
  });
});

describe('readBodyJson', () => {
  it('parses JSON with the right content type', async () => {
    const r = req('{"a":1}', { 'content-type': 'application/json; charset=utf-8' });
    expect(await readBodyJson(r, { maxBytes: 100 })).toEqual({ a: 1 });
  });

  it('requires application/json by default', async () => {
    expect(await code(readBodyJson(req('{}', { 'content-type': 'text/plain' }), { maxBytes: 100 }))).toBe('unsupported_media_type:415');
  });

  it('can skip the content type check', async () => {
    expect(await readBodyJson(req('[1]'), { maxBytes: 100, requireContentType: null })).toEqual([1]);
  });

  it('rejects invalid JSON', async () => {
    const r = req('{nope', { 'content-type': 'application/json' });
    expect(await code(readBodyJson(r, { maxBytes: 100 }))).toBe('invalid_json:400');
  });
});
