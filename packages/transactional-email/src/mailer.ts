import type { MailCapture } from './capture.js';
import type { CapturedMail, MailFailureReason, MailMessage, SendOptions, SendResult } from './types.js';

export interface MailerConfig {
  /** The Resend API key (`re_...`). Without a usable key, and without a `capture`, every send fails with `not_configured`. */
  readonly apiKey?: string | undefined;
  /** Default sender, such as `Example <orders@example.com>`. A message can override it. */
  readonly from?: string | undefined;
  /** Send nothing; record every message here and answer `ok` with a `mock_` id. For tests and for a build without a live key. */
  readonly capture?: MailCapture | undefined;
  /** How long to wait for Resend, 10000 by default. */
  readonly timeoutMs?: number | undefined;
  /** `https://api.resend.com` by default. */
  readonly baseUrl?: string | undefined;
  /** The `fetch` to use, global `fetch` by default. */
  readonly fetch?: typeof fetch | undefined;
}

export interface Mailer {
  /** Send a message. Never throws: read `ok` on the result. */
  send(message: MailMessage, options?: SendOptions): Promise<SendResult>;
  /** Send a message and throw a `MailSendError` when it is not accepted. Returns the message id, if there is one. */
  sendOrThrow(message: MailMessage, options?: SendOptions): Promise<string | undefined>;
}

/** What `sendOrThrow` throws. Its message is the fixed `error` sentence of the failed result. */
export class MailSendError extends Error {
  readonly reason: MailFailureReason;
  readonly status: number | undefined;
  readonly retryable: boolean;
  constructor(failure: Extract<SendResult, { ok: false }>) {
    super(failure.error);
    this.name = 'MailSendError';
    this.reason = failure.reason;
    this.status = failure.status;
    this.retryable = failure.retryable;
  }
}

/** True for a key that looks like a real Resend key: `re_` and 8 to 240 URL-safe characters, and not a `re_placeholder` stand-in. */
export function isLiveKey(apiKey: string | undefined): apiKey is string {
  return typeof apiKey === 'string' && /^re_[A-Za-z0-9_-]{8,240}$/.test(apiKey) && !apiKey.startsWith('re_placeholder');
}

function fail(reason: MailFailureReason, error: string, status?: number): Extract<SendResult, { ok: false }> {
  return { ok: false, reason, status, retryable: reason === 'unavailable' || reason === 'timeout', error };
}

const oneLine = (value: string): boolean => !/[\r\n\0]/.test(value);

function list(value: string | readonly string[] | undefined): string[] {
  return value === undefined ? [] : typeof value === 'string' ? [value] : [...value];
}

/** The first problem with a message, named by field and never by value, or `undefined`. */
function problem(message: MailMessage, from: string | undefined, to: string[], cc: string[], bcc: string[], replyTo: string[]): string | undefined {
  if (!from || !oneLine(from)) return 'from is missing or not one line';
  if (!to.length) return 'to is empty';
  for (const [field, addresses] of [['to', to], ['cc', cc], ['bcc', bcc], ['replyTo', replyTo]] as const) {
    if (addresses.some((address) => !address.trim() || !oneLine(address) || !/@/.test(address) || /[,;]/.test(address.replace(/^[^<]*</, '<')))) return `${field} holds an invalid address`;
  }
  if (!message.subject.trim() || !oneLine(message.subject)) return 'subject is missing or not one line';
  if (!message.text && !message.html) return 'the message needs text or html';
  for (const [name, value] of Object.entries(message.headers ?? {})) if (!/^[A-Za-z0-9-]{1,100}$/.test(name) || !oneLine(value)) return 'headers hold an invalid name or value';
  for (const tag of message.tags ?? []) if (!/^[A-Za-z0-9_-]{1,256}$/.test(tag.name) || !/^[A-Za-z0-9_-]{1,256}$/.test(tag.value)) return 'tags hold an invalid name or value';
  for (const attachment of message.attachments ?? []) if (!attachment.filename || !oneLine(attachment.filename) || !attachment.content) return 'an attachment is missing a filename or content';
  return undefined;
}

/** Resend's JSON body: snake_case names, lists for addresses, and only the fields that are set. */
function payload(message: MailMessage, from: string, to: string[], cc: string[], bcc: string[], replyTo: string[]): Record<string, unknown> {
  return {
    from,
    to,
    ...(cc.length ? { cc } : {}),
    ...(bcc.length ? { bcc } : {}),
    ...(replyTo.length ? { reply_to: replyTo } : {}),
    subject: message.subject,
    ...(message.text ? { text: message.text } : {}),
    ...(message.html ? { html: message.html } : {}),
    ...(message.headers && Object.keys(message.headers).length ? { headers: message.headers } : {}),
    ...(message.tags?.length ? { tags: message.tags } : {}),
    ...(message.attachments?.length
      ? { attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content, ...(a.contentType ? { content_type: a.contentType } : {}) })) }
      : {}),
  };
}

/**
 * A sender for Resend's REST API that uses only `fetch`. It validates the message, sends an `Idempotency-Key` when you give one,
 * stops waiting after `timeoutMs`, does not follow redirects, and reports failures as fixed sentences that never hold the provider's
 * response (which can echo what you submitted), the API key or an address.
 */
export function createMailer(config: MailerConfig = {}): Mailer {
  const timeoutMs = config.timeoutMs ?? 10_000;
  const baseUrl = (config.baseUrl ?? 'https://api.resend.com').replace(/\/+$/, '');

  async function send(message: MailMessage, options: SendOptions = {}): Promise<SendResult> {
    const from = message.from ?? config.from;
    const to = list(message.to);
    const cc = list(message.cc);
    const bcc = list(message.bcc);
    const replyTo = list(message.replyTo);
    const bad = problem(message, from, to, cc, bcc, replyTo);
    if (bad) return fail('invalid', `The message is not valid: ${bad}.`);
    const key = options.idempotencyKey;
    if (key !== undefined && !/^[\x21-\x7e]{1,256}$/.test(key)) return fail('invalid', 'The message is not valid: idempotencyKey must be 1 to 256 printable ASCII characters.');

    if (config.capture) {
      const captured: CapturedMail = config.capture.record({
        from: from as string,
        to,
        cc,
        bcc,
        replyTo,
        subject: message.subject,
        text: message.text,
        html: message.html,
        headers: message.headers,
        tags: message.tags,
        attachments: (message.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType })),
        idempotencyKey: key,
      });
      return { ok: true, id: captured.id, captured: true };
    }
    if (!isLiveKey(config.apiKey)) return fail('not_configured', 'No usable Resend API key is configured.');

    const fetcher = config.fetch ?? fetch;
    let response: Response;
    try {
      response = await fetcher(`${baseUrl}/emails`, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          'content-type': 'application/json',
          ...(key ? { 'idempotency-key': key } : {}),
        },
        body: JSON.stringify(payload(message, from as string, to, cc, bcc, replyTo)),
      });
    } catch (error) {
      const name = (error as { name?: unknown } | null)?.name;
      if (name === 'TimeoutError' || name === 'AbortError') return fail('timeout', `Resend did not answer within ${timeoutMs} ms.`);
      return fail('unavailable', 'The request to Resend failed; details withheld.');
    }

    const status = response.status;
    if (response.ok) {
      let id: string | undefined;
      try {
        const body = (await response.json()) as { id?: unknown } | null;
        if (typeof body?.id === 'string' && body.id) id = body.id;
      } catch {
        // An accepted message with an unreadable answer is still accepted.
      }
      return { ok: true, id, captured: false };
    }
    // The body is never read: provider error text can echo the addresses and content that were submitted.
    void response.body?.cancel().catch(() => undefined);
    if (status === 429) return fail('unavailable', 'Resend is rate limiting requests (HTTP 429).', status);
    if (status >= 500 || status === 408) return fail('unavailable', `Resend is unavailable (HTTP ${status}).`, status);
    return fail('rejected', `Resend rejected the message (HTTP ${status}).`, status);
  }

  return {
    send,
    async sendOrThrow(message, options) {
      const result = await send(message, options);
      if (!result.ok) throw new MailSendError(result);
      return result.id;
    },
  };
}
