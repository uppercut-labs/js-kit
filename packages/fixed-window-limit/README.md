# @uppercut-labs/fixed-window-limit

A fixed-window attempt limiter for sign-in, magic-link, checkout and API routes. One core decides; small store adapters keep the counters: in memory, in Cloudflare D1 or in Postgres. No runtime dependencies. It uses only Web Crypto, so it runs in Cloudflare Workers, Deno, Bun, browsers and Node 18+.

```sh
npm install @uppercut-labs/fixed-window-limit
```

```ts
import { createD1Store, createLimiter } from '@uppercut-labs/fixed-window-limit';

export default {
  async fetch(request: Request, env: { DB: D1Database; LIMIT_KEY: string }) {
    const limiter = createLimiter({
      store: createD1Store(env.DB),
      fingerprintKey: env.LIMIT_KEY, // at least 32 bytes
      partition: 'shop-1',
      policy: { maxAttempts: 5, windowMs: 15 * 60_000 },
    });
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const decision = await limiter.consume({ action: 'sign-in', subject: ip });
    if (!decision.allowed) {
      return new Response('Too many attempts', { status: 429, headers: { 'Retry-After': String(decision.retryAfterSeconds) } });
    }
    return new Response('ok');
  },
};
```

## How it decides

Time is cut into fixed windows of `windowMs`, aligned to the epoch. Each `(partition, action, subject)` has one counter per window. `consume` takes one slot only while the counter is below `maxAttempts`; a refused attempt does not raise it. When the window ends the counter is simply a different row.

- **Atomic.** The D1 and Postgres stores reserve with a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE count < max RETURNING` statement, so concurrent requests on any number of instances cannot each take the last slot.
- **Fail closed.** If the store throws, `consume` throws. A malformed store answer throws a `FixedWindowError`. Nothing is ever allowed because storage was down; decide in your route what to answer.
- **No raw subjects stored.** The store sees `partition`, a hex HMAC-SHA256 of `JSON.stringify([partition, action, subject])` under your `fingerprintKey`, and the window times. Emails and addresses never reach the database. Change the key and every counter starts again.

## Limiter

`createLimiter({ store, fingerprintKey, partition, policy?, sweep? })`

| Option | Meaning |
| --- | --- |
| `store` | A `CounterStore`: see below |
| `fingerprintKey` | `Uint8Array` or string of at least 32 bytes |
| `partition` | Namespace stored in clear, such as a tenant or environment. Letters, digits and `_ . : -`, up to 200 characters |
| `policy` | Default `{ maxAttempts, windowMs }`, both positive safe integers. Each call may pass its own |
| `sweep` | `{ probability, limit, random?, onError? }`: after a consume, with that chance, delete up to `limit` expired windows. A failed sweep calls `onError` and never fails the request |

`limiter.consume({ action, subject, policy?, now? })` returns `{ allowed, retryAfterMs, retryAfterSeconds, limit, remaining, resetAt }`. `action` uses the same characters as `partition`; `subject` is 1 to 2048 characters; `now` defaults to `Date.now()`.

`limiter.peek(...)` takes the same arguments and returns `{ limited, count, remaining, resetAt }` without taking an attempt. It needs a store with `count`, which all three included stores have. Use it to refuse early on a counter that something else increments, such as failed credentials.

Invalid input throws `FixedWindowError` with `code` `invalid_config`, `invalid_attempt`, `invalid_store_result` or `unsupported_store`.

## Stores

### D1

```ts
import { createD1Store, d1CounterSchema } from '@uppercut-labs/fixed-window-limit';

d1CounterSchema(); // the CREATE TABLE and index statements, to put in a migration
createD1Store(env.DB, { table: 'fixed_window_counters', columns: { count: 'attempts' } });
```

The table needs five columns (`partition`, `key`, `window_start`, `expires_at`, `count` by default) and a primary key or unique index over the first three. Pass `table` and `columns` to keep an existing schema.

### Postgres

```ts
import { createPostgresStore, postgresCounterSchema } from '@uppercut-labs/fixed-window-limit';

createPostgresStore(pool); // any object with query(text, values) -> { rows, rowCount }, such as a pg Pool
```

Defaults to a `bigint` window in epoch milliseconds. For an existing table use `windowType: 'timestamptz'`, `columns: { partition: null }` when it has no partition column, and `columns: { expiresAt: null }` when it has no expiry column; then `deleteExpired` removes windows that started more than `retainMs` ago (default two days). Table and column names are validated and quoted. `schema.table` is accepted.

### Memory

`createMemoryStore()` keeps counters in the process. Use it in tests or single-instance tools.

### Your own store

```ts
interface CounterStore {
  tryAcquire(r: { partition; key; windowStart; expiresAt; maxAttempts }): Promise<{ allowed: boolean; count: number }>;
  count?(w: { partition; key; windowStart }): Promise<number>;
  deleteExpired?(now: number, limit: number): Promise<number>;
}
```

`tryAcquire` must reserve atomically, must not raise the counter when it refuses, and must throw on storage failure.

## Tests

The suite runs the SQL of the D1 store on SQLite (sql.js) and of the Postgres store on Postgres (PGlite), and runs reference copies of the limiters this package replaces beside it to compare decisions and stored rows.

## License

MIT
