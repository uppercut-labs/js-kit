import { describe, expect, it } from 'vitest';
import { bareAddress, createMailCapture, createMailer, escapeHtml, isLiveKey, MailSendError, type MailMessage } from '../src/index.js';

const KEY = `re_${'x'.repeat(24)}`;
const MESSAGE: MailMessage = { to: 'buyer@example.com', subject: 'Your order', text: 'Thanks.', html: '<p>Thanks.</p>' };

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Headers;
}

function fakeFetch(respond: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call: Call = { url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body ?? '{}')), headers: new Headers(init?.headers) };
    calls.push(call);
    return respond(call);
  };
  return { fetch: impl as typeof fetch, calls };
}

const accepted = () => new Response(JSON.stringify({ id: 'em_123' }), { status: 200, headers: { 'content-type': 'application/json' } });

describe('sending', () => {
  it('posts the message to Resend with the key and returns the message id', async () => {
    const { fetch: f, calls } = fakeFetch(accepted);
    const mailer = createMailer({ apiKey: KEY, from: 'Example <orders@example.com>', fetch: f });
    const result = await mailer.send({ ...MESSAGE, replyTo: 'help@example.com', cc: ['a@example.com'], tags: [{ name: 'kind', value: 'order' }] });
    expect(result).toEqual({ ok: true, id: 'em_123', captured: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.resend.com/emails');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.headers.get('content-type')).toBe('application/json');
    expect(calls[0]?.headers.has('idempotency-key')).toBe(false);
    expect(calls[0]?.body).toEqual({
      from: 'Example <orders@example.com>',
      to: ['buyer@example.com'],
      cc: ['a@example.com'],
      reply_to: ['help@example.com'],
      subject: 'Your order',
      text: 'Thanks.',
      html: '<p>Thanks.</p>',
      tags: [{ name: 'kind', value: 'order' }],
    });
  });

  it('sends the idempotency key as a header', async () => {
    const { fetch: f, calls } = fakeFetch(accepted);
    await createMailer({ apiKey: KEY, from: 'a@example.com', fetch: f }).send(MESSAGE, { idempotencyKey: 'order/42' });
    expect(calls[0]?.headers.get('idempotency-key')).toBe('order/42');
  });

  it('lets a message set its own sender, lists, headers and attachments', async () => {
    const { fetch: f, calls } = fakeFetch(accepted);
    await createMailer({ apiKey: KEY, from: 'default@example.com', fetch: f }).send({
      to: ['a@example.com', 'B <b@example.com>'],
      bcc: 'c@example.com',
      from: 'Other <other@example.com>',
      subject: 'S',
      html: '<p>x</p>',
      headers: { 'List-Unsubscribe': '<mailto:u@example.com>' },
      attachments: [{ filename: 'a.txt', content: 'aGk=', contentType: 'text/plain' }],
    });
    expect(calls[0]?.body).toEqual({
      from: 'Other <other@example.com>',
      to: ['a@example.com', 'B <b@example.com>'],
      bcc: ['c@example.com'],
      subject: 'S',
      html: '<p>x</p>',
      headers: { 'List-Unsubscribe': '<mailto:u@example.com>' },
      attachments: [{ filename: 'a.txt', content: 'aGk=', content_type: 'text/plain' }],
    });
  });

  it('uses another base URL', async () => {
    const { fetch: f, calls } = fakeFetch(accepted);
    await createMailer({ apiKey: KEY, from: 'a@example.com', fetch: f, baseUrl: 'https://mail.example.test/' }).send(MESSAGE);
    expect(calls[0]?.url).toBe('https://mail.example.test/emails');
  });

  it('counts an accepted message with an unreadable answer as accepted, without an id', async () => {
    const { fetch: f } = fakeFetch(() => new Response('not json', { status: 200 }));
    expect(await createMailer({ apiKey: KEY, from: 'a@example.com', fetch: f }).send(MESSAGE)).toEqual({ ok: true, id: undefined, captured: false });
  });
});

describe('failures', () => {
  const SECRET_BODY = JSON.stringify({ name: 'validation_error', message: 'The to field buyer@example.com with secret-token is invalid' });

  it('keeps the provider response out of a rejection', async () => {
    const { fetch: f } = fakeFetch(() => new Response(SECRET_BODY, { status: 422 }));
    const result = await createMailer({ apiKey: KEY, from: 'a@example.com', fetch: f }).send(MESSAGE);
    expect(result).toEqual({ ok: false, reason: 'rejected', status: 422, retryable: false, error: 'Resend rejected the message (HTTP 422).' });
    expect(JSON.stringify(result)).not.toMatch(/secret-token|buyer@example\.com|re_test/);
  });

  it('marks a server error, a 408 and a rate limit as retryable', async () => {
    for (const [status, text] of [
      [500, 'Resend is unavailable (HTTP 500).'],
      [503, 'Resend is unavailable (HTTP 503).'],
      [408, 'Resend is unavailable (HTTP 408).'],
      [429, 'Resend is rate limiting requests (HTTP 429).'],
    ] as const) {
      const { fetch: f } = fakeFetch(() => new Response(SECRET_BODY, { status }));
      expect(await createMailer({ apiKey: KEY, from: 'a@example.com', fetch: f }).send(MESSAGE)).toEqual({ ok: false, reason: 'unavailable', status, retryable: true, error: text });
    }
  });

  it('reports a network error without its text', async () => {
    const { fetch: f } = fakeFetch(() => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED https://api.resend.com with ${KEY}`);
    });
    const result = await createMailer({ apiKey: KEY, from: 'a@example.com', fetch: f }).send(MESSAGE);
    expect(result).toEqual({ ok: false, reason: 'unavailable', status: undefined, retryable: true, error: 'The request to Resend failed; details withheld.' });
  });

  it('gives up after the timeout and says it may have been accepted', async () => {
    const { fetch: f } = fakeFetch(
      (call) =>
        new Promise<Response>((_resolve, reject) => {
          (call.init.signal as AbortSignal).addEventListener('abort', () => reject((call.init.signal as AbortSignal).reason));
        }),
    );
    const started = Date.now();
    const result = await createMailer({ apiKey: KEY, from: 'a@example.com', fetch: f, timeoutMs: 30 }).send(MESSAGE, { idempotencyKey: 'k' });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result).toEqual({ ok: false, reason: 'timeout', status: undefined, retryable: true, error: 'Resend did not answer within 30 ms.' });
  });

  it('throws a MailSendError from sendOrThrow and returns the id on success', async () => {
    const bad = createMailer({ apiKey: KEY, from: 'a@example.com', fetch: fakeFetch(() => new Response('x', { status: 403 })).fetch });
    await expect(bad.sendOrThrow(MESSAGE)).rejects.toMatchObject({ name: 'MailSendError', reason: 'rejected', status: 403, retryable: false, message: 'Resend rejected the message (HTTP 403).' });
    await expect(bad.sendOrThrow(MESSAGE)).rejects.toBeInstanceOf(MailSendError);
    const good = createMailer({ apiKey: KEY, from: 'a@example.com', fetch: fakeFetch(accepted).fetch });
    await expect(good.sendOrThrow(MESSAGE)).resolves.toBe('em_123');
  });
});

describe('validation: nothing is sent for a bad message', () => {
  const run = async (message: Partial<MailMessage> & { to?: MailMessage['to'] }, key?: string, from: string | null = 'a@example.com') => {
    const { fetch: f, calls } = fakeFetch(accepted);
    const result = await createMailer({ apiKey: KEY, from: from ?? undefined, fetch: f }).send({ ...MESSAGE, ...message }, key === undefined ? {} : { idempotencyKey: key });
    expect(calls).toHaveLength(result.ok ? 1 : 0);
    return result;
  };
  const invalid = (what: string) => ({ ok: false, reason: 'invalid', status: undefined, retryable: false, error: `The message is not valid: ${what}.` });

  it('needs a sender, a recipient, a subject and a body', async () => {
    expect(await run({}, undefined, null)).toEqual(invalid('from is missing or not one line'));
    expect(await run({ to: [] })).toEqual(invalid('to is empty'));
    expect(await run({ subject: ' ' })).toEqual(invalid('subject is missing or not one line'));
    expect(await run({ text: undefined, html: undefined })).toEqual(invalid('the message needs text or html'));
  });

  it('refuses a line break that could add a header or a recipient', async () => {
    expect(await run({ subject: 'Hi\r\nBcc: x@example.com' })).toEqual(invalid('subject is missing or not one line'));
    expect(await run({ to: 'a@example.com\nbcc: x@example.com' })).toEqual(invalid('to holds an invalid address'));
    expect(await run({ replyTo: 'x@example.com\r\n' })).toEqual(invalid('replyTo holds an invalid address'));
    expect(await run({ headers: { 'X-A': 'a\nSet-Cookie: b=1' } })).toEqual(invalid('headers hold an invalid name or value'));
    expect(await run({ headers: { 'X-A\n': 'a' } })).toEqual(invalid('headers hold an invalid name or value'));
  });

  it('refuses something that is not an address, and a list in one string', async () => {
    expect(await run({ to: 'not-an-address' })).toEqual(invalid('to holds an invalid address'));
    expect(await run({ to: 'a@example.com, b@example.com' })).toEqual(invalid('to holds an invalid address'));
    expect(await run({ cc: [''] })).toEqual(invalid('cc holds an invalid address'));
    expect((await run({ to: 'Doe, Jo <jo@example.com>' })).ok).toBe(true);
  });

  it('checks tags, attachments and the idempotency key', async () => {
    expect(await run({ tags: [{ name: 'a b', value: 'x' }] })).toEqual(invalid('tags hold an invalid name or value'));
    expect(await run({ attachments: [{ filename: '', content: 'aGk=' }] })).toEqual(invalid('an attachment is missing a filename or content'));
    expect(await run({}, 'a b')).toEqual(invalid('idempotencyKey must be 1 to 256 printable ASCII characters'));
    expect(await run({}, 'x'.repeat(257))).toEqual(invalid('idempotencyKey must be 1 to 256 printable ASCII characters'));
    expect(await run({}, '')).toEqual(invalid('idempotencyKey must be 1 to 256 printable ASCII characters'));
  });
});

describe('configuration', () => {
  it('fails without sending when there is no usable key', async () => {
    const { fetch: f, calls } = fakeFetch(accepted);
    for (const apiKey of [undefined, '', 're_placeholder_key_123456', 'not-a-key', `${KEY} `, `${KEY}\n`]) {
      const result = await createMailer({ apiKey, from: 'a@example.com', fetch: f }).send(MESSAGE);
      expect(result).toEqual({ ok: false, reason: 'not_configured', status: undefined, retryable: false, error: 'No usable Resend API key is configured.' });
    }
    expect(calls).toHaveLength(0);
  });

  it('recognises a live key', () => {
    expect(isLiveKey(KEY)).toBe(true);
    expect(isLiveKey('re_placeholder_abcdefgh')).toBe(false);
    expect(isLiveKey('re_short')).toBe(false);
    expect(isLiveKey(undefined)).toBe(false);
  });
});

describe('capture', () => {
  it('records the message and sends nothing, even with a live key', async () => {
    const capture = createMailCapture();
    const { fetch: f, calls } = fakeFetch(accepted);
    const mailer = createMailer({ apiKey: KEY, from: 'Example <orders@example.com>', fetch: f, capture });
    const first = await mailer.send({ ...MESSAGE, replyTo: 'help@example.com', attachments: [{ filename: 'a.txt', content: 'aGk=', contentType: 'text/plain' }] }, { idempotencyKey: 'order/1' });
    const second = await mailer.send({ ...MESSAGE, to: ['Other <OTHER@example.com>'], subject: 'Second' });
    expect(first).toEqual({ ok: true, id: 'mock_1', captured: true });
    expect(second).toEqual({ ok: true, id: 'mock_2', captured: true });
    expect(calls).toHaveLength(0);
    expect(capture.sent).toHaveLength(2);
    expect(capture.last()?.subject).toBe('Second');
    expect(capture.sent[0]).toMatchObject({
      id: 'mock_1',
      from: 'Example <orders@example.com>',
      to: ['buyer@example.com'],
      cc: [],
      bcc: [],
      replyTo: ['help@example.com'],
      subject: 'Your order',
      text: 'Thanks.',
      html: '<p>Thanks.</p>',
      attachments: [{ filename: 'a.txt', contentType: 'text/plain' }],
      idempotencyKey: 'order/1',
    });
    expect(JSON.stringify(capture.sent[0])).not.toContain('aGk=');
    expect(capture.to('other@example.com')).toHaveLength(1);
    expect(capture.to('BUYER@example.com')).toHaveLength(1);
    capture.clear();
    expect(capture.sent).toHaveLength(0);
    expect(capture.last()).toBeUndefined();
  });

  it('still validates, and works with no key at all', async () => {
    const capture = createMailCapture();
    const mailer = createMailer({ from: 'a@example.com', capture });
    expect(await mailer.send({ ...MESSAGE, to: 'nope' })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(capture.sent).toHaveLength(0);
    expect(await mailer.send(MESSAGE)).toMatchObject({ ok: true, captured: true });
  });

  it('reduces an address to its bare, lower-case form', () => {
    expect(bareAddress('Name <Name@Example.COM>')).toBe('name@example.com');
    expect(bareAddress(' a@b.test ')).toBe('a@b.test');
  });
});

describe('escapeHtml', () => {
  it('escapes the five characters that matter in a mail body', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});
