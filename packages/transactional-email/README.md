# @uppercut-labs/transactional-email

Send transactional email (sign-in links, receipts, download links) through the [Resend](https://resend.com) REST API with `fetch` only. It validates the message, sends an idempotency key, stops waiting after a timeout, never follows a redirect, reports failures as fixed sentences that do not echo the provider's response, and can record mail in memory for tests instead of sending it. No dependencies. It runs in Cloudflare Workers, Deno, Bun and Node 18+.

```sh
npm install @uppercut-labs/transactional-email
```

```ts
import { createMailer, escapeHtml } from '@uppercut-labs/transactional-email';

const mailer = createMailer({ apiKey: env.RESEND_API_KEY, from: 'Example <orders@example.com>', timeoutMs: 2500 });

const result = await mailer.send(
  {
    to: order.email,
    subject: 'Your download',
    text: `Your files: ${link}`,
    html: `<p><a href="${escapeHtml(link)}">Your files</a></p>`,
  },
  { idempotencyKey: `order/${order.id}` },
);
if (!result.ok) console.warn('mail not sent', result.reason, result.status, result.error);
```

The sender address, the domain it belongs to and the key come from your configuration; nothing about a sender is built in.

## `createMailer(config)`

| Option | Meaning |
| --- | --- |
| `apiKey` | The Resend key. Without a usable one, and without a `capture`, `send` fails with `not_configured` and nothing is sent. A usable key is `re_` and 8 to 240 URL-safe characters; a `re_placeholder...` stand-in is not usable |
| `from` | Default sender. A message can set its own |
| `capture` | A `MailCapture` (see below). Mail is recorded and never sent |
| `timeoutMs` | How long to wait for Resend. 10000 by default |
| `baseUrl` | `https://api.resend.com` by default |
| `fetch` | The `fetch` to use. Global `fetch` by default |
| `cache` | A `cache` mode to pass to `fetch`, such as `'no-store'`, for a runtime that supports the option. Not set by default |

`mailer.send(message, { idempotencyKey? })` never throws. `mailer.sendOrThrow(message, options)` throws a `MailSendError` (`reason`, `status`, `retryable`) and returns the message id.

### Message

`{ to, subject, text?, html?, from?, replyTo?, cc?, bcc?, headers?, tags?, attachments? }`. Addresses are a string or a list and may be `Name <name@example.com>`. At least one of `text` and `html` is needed. Attachments are `{ filename, content (base64), contentType? }`.

Before anything is sent the message is checked: a sender, at least one recipient, one-line subject, addresses and header values (a line break could add a header or a recipient), valid header and tag names, and a printable-ASCII idempotency key of at most 256 characters. A bad message gives `{ ok: false, reason: 'invalid' }` and the error names the field, never its value.

### Result

- `{ ok: true, id, captured }`: Resend accepted the message (`id` is absent only if its answer held none). A captured message has a `mock_` id.
- `{ ok: false, reason, status?, retryable, error }` with `reason` one of:
  - `invalid`: not sent, fix the message.
  - `not_configured`: not sent, no usable key.
  - `rejected`: Resend answered with a 4xx other than 408 and 429. Retrying the same message will not help.
  - `unavailable`: a 5xx, 408 or 429, or a network error. `retryable` is true.
  - `timeout`: no answer in time. The message may have been accepted, so retry with the same idempotency key. `retryable` is true.

`error` is one of a few fixed sentences (`Resend rejected the message (HTTP 422).`). Resend's response body is never read, because it can echo the addresses and content that were submitted, and the key and the addresses are never put in an error.

### Idempotency

Resend keeps the first result for a key for 24 hours and answers a repeat with it, so a retry after a timeout or a crash does not send a second mail. Name the key for the thing being sent (`order/<id>`, `recovery/<delivery id>`), not for the attempt.

## Tests without sending

```ts
import { createMailCapture, createMailer } from '@uppercut-labs/transactional-email';

const capture = createMailCapture();
const mailer = createMailer({ from: 'Example <orders@example.com>', capture });
await mailer.send({ to: 'buyer@example.com', subject: 'Hi', text: 'Hello' }, { idempotencyKey: 'order/1' });

capture.last()?.subject; // 'Hi'
capture.to('BUYER@example.com'); // every captured message to that address
capture.sent; // all of them, oldest first, with from, to, cc, bcc, replyTo, text, html, headers, tags,
              // attachments (with their base64 content) and the idempotency key
capture.clear();
```

A mailer with a `capture` validates exactly as a live one does and sends nothing, whatever key it holds. Use it for tests, and for a preview that has no live key (`createMailer({ apiKey, capture: isLiveKey(apiKey) ? undefined : capture })`; `isLiveKey` is false for a missing key and for a `re_placeholder` one).

## `escapeHtml(text)`

Escapes `& < > " '` for a mail body or an attribute.

## Tests

The suite runs the mailer against a fake `fetch`: the exact request (URL, headers, JSON body), every failure path with a provider body that holds an address and a secret, the timeout, validation of every field and the capture. All addresses use `example.com`; no test reaches a network.

## License

MIT
