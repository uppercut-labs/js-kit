# @uppercut-labs/signed-webhooks

Sign outbound webhooks, verify inbound ones, check `Stripe-Signature` headers and remember which deliveries were already received. HMAC-SHA256 over `timestamp.body`, a tolerance window on the timestamp, constant-time comparison, no runtime dependencies. It uses only Web Crypto, so it runs in Cloudflare Workers, Deno, Bun, browsers and Node 18+.

```sh
npm install @uppercut-labs/signed-webhooks
```

## Send

```ts
import { buildEnvelope, signWebhookHeader } from '@uppercut-labs/signed-webhooks';

const body = JSON.stringify(buildEnvelope({
  id: 'evt_123',
  type: 'order.created',
  occurredAt: new Date().toISOString(),
  extra: { project: { id: 'p_1' } },
  data: { total: 4200 },
}));
const timestamp = new Date().toISOString();
await fetch(url, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Webhook-Timestamp': timestamp,
    'X-Webhook-Signature': await signWebhookHeader(secret, timestamp, body), // sha256=<hex>
  },
  body,
});
```

`signWebhook(secret, timestamp, body)` returns the bare hex digest. The timestamp is a string or number; the signed message is `` `${timestamp}.` `` followed by the exact body bytes.

## Receive

```ts
import { verifyWebhook } from '@uppercut-labs/signed-webhooks';

const body = await request.text(); // the raw body, before any JSON.parse
const result = await verifyWebhook(
  [env.SECRET_CURRENT, env.SECRET_PREVIOUS],
  request.headers.get('X-Webhook-Timestamp') ?? '',
  body,
  request.headers.get('X-Webhook-Signature'),
);
if (!result.ok) return new Response(result.reason, { status: 400 });
```

`verifyWebhook(secrets, timestamp, body, signature, options?)` accepts one secret or a list (rotation, or separate live and test secrets), one signature or a list, with or without the `sha256=` prefix. It returns `{ ok: true, secretIndex, timestampMs }` or `{ ok: false, reason }`, where `reason` is `missing_signature`, `malformed_signature`, `invalid_timestamp`, `timestamp_outside_tolerance` or `no_matching_signature`.

| Option | Default | Meaning |
| --- | --- | --- |
| `toleranceSeconds` | `300` | Largest distance between the signed time and now, either way. `null` skips the check |
| `now` | the current time | Epoch milliseconds or a `Date`, for tests |

A numeric timestamp, or a string of digits, is unix seconds. Any other string must be a date string such as ISO 8601.

## Stripe

```ts
import { verifyStripeSignature } from '@uppercut-labs/signed-webhooks';

const result = await verifyStripeSignature(
  await request.text(),
  request.headers.get('Stripe-Signature'),
  [env.STRIPE_WEBHOOK_SECRET, env.STRIPE_WEBHOOK_SECRET_LIVE],
);
if (!result.ok) return new Response(result.reason, { status: 400 });
```

This follows Stripe's documented scheme: the header is `t=<unix seconds>,v1=<hex>[,v1=<hex>]`, the signed payload is `` `${t}.${payload}` ``, the key is the endpoint secret used as-is, any `v1` may match, and the default tolerance is five minutes. Unknown schemes such as `v0` are ignored; a missing or repeated `t`, or no well-formed `v1`, is `malformed_header`. The result is `{ ok: true, timestamp, secretIndex }` or `{ ok: false, reason }` with `missing_header`, `malformed_header`, `timestamp_outside_tolerance` or `no_matching_signature`.

`signStripeHeader(secret, body, timestampSeconds)` builds a header for tests and mocks. The package's tests use synthetic secrets and check one digest against `openssl dgst`.

Verifying the signature says the event came from the holder of the secret. It does not check the account, the mode (live or test) or the event contents; do that on the parsed event.

## Do not process a delivery twice

```ts
import { createD1ReceiptStore, createReceiptLedger } from '@uppercut-labs/signed-webhooks';

const ledger = createReceiptLedger(createD1ReceiptStore(env.DB)); // see d1ReceiptSchema()
const status = await ledger.record({ scope: 'billing', id: event.id, body });
if (status === 'duplicate') return new Response('ok');
if (status === 'conflict') return new Response('event id reused', { status: 409 });
// 'new': do the work
```

`record` takes `{ scope, id, body | digest, now? }` and returns `'new'` (first sight), `'duplicate'` (same id, same payload) or `'conflict'` (same id, different payload). `body` is hashed with SHA-256; only the digest is stored. The D1 store decides with one `INSERT ... ON CONFLICT DO NOTHING RETURNING`, so racing deliveries of one event cannot both be `'new'`. A storage error throws, which fails the request so the sender retries. `createMemoryReceiptStore()` is for tests and single-instance tools. A store is two lines: `putIfAbsent(receipt)` returning `{ inserted: true }` or `{ inserted: false, digest }`.

## Other exports

- `timingSafeEqual(a, b)`: compare strings or bytes without stopping at the first difference.
- `buildEnvelope({ id, type, occurredAt, data, extra? })`: `{ schema_version: 1, event_id, event_type, occurred_at, ...extra, data }` with a fixed key order, so one event always signs to the same bytes. `extra` cannot overwrite the fixed fields.
- `parseTimestamp(value)`: the epoch milliseconds a timestamp means, or `null`.
- `digestPayload(body)`: SHA-256 hex.
- `WebhookError` with `code` `invalid_secret`, `invalid_input` or `storage_conflict`, thrown for programmer errors. Failed verification is a result, never a throw.

## Tests

The suite runs beside copies of the verifiers it replaces (a Node-crypto signer and verifier, a lenient Workers handler check and a strict Stripe check) and compares their answers on valid, tampered, expired, future and malformed input. The D1 store runs its SQL on SQLite (sql.js).

## License

MIT
