import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createLimiter, createPostgresStore, FixedWindowError, postgresCounterSchema } from '../src/index.js';
import { createFakePg, referencePg } from './helpers.js';

const KEY = new Uint8Array(32).fill(5);
const T = 1_700_000_000_000;
const HOUR = 60 * 60 * 1000;

let pg: Awaited<ReturnType<typeof createFakePg>>;
beforeAll(async () => {
  pg = await createFakePg();
});
afterAll(async () => {
  await pg.raw.close();
});
beforeEach(async () => {
  await pg.raw.exec('DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
});

describe('Postgres store on the default table', () => {
  const r = { partition: 'p', key: 'b'.repeat(64), windowStart: 3_600_000, expiresAt: 7_200_000, maxAttempts: 3 };

  beforeEach(async () => {
    await pg.query(postgresCounterSchema());
  });

  it('counts up to the limit and then holds the counter', async () => {
    const s = createPostgresStore(pg);
    const results = [];
    for (let i = 0; i < 6; i += 1) results.push(await s.tryAcquire(r));
    expect(results.map((x) => x.allowed)).toEqual([true, true, true, false, false, false]);
    expect(results.map((x) => x.count)).toEqual([1, 2, 3, 3, 3, 3]);
    expect(await s.count!(r)).toBe(3);
    expect((await pg.query('SELECT count FROM fixed_window_counters')).rows).toEqual([{ count: 3 }]);
  });

  it('never over-admits when many reservations are in flight', async () => {
    const s = createPostgresStore(pg);
    const results = await Promise.all(Array.from({ length: 25 }, () => s.tryAcquire(r)));
    expect(results.filter((x) => x.allowed)).toHaveLength(3);
  });

  it('refuses when the stored window end differs', async () => {
    const s = createPostgresStore(pg);
    await s.tryAcquire(r);
    expect((await s.tryAcquire({ ...r, expiresAt: 10_800_000 })).allowed).toBe(false);
  });

  it('deletes expired windows by their end', async () => {
    const s = createPostgresStore(pg);
    for (let i = 0; i < 4; i += 1) await s.tryAcquire({ ...r, key: String(i).repeat(64), windowStart: i * 100, expiresAt: i * 100 + 100 });
    expect(await s.deleteExpired!(250, 1)).toBe(1);
    expect(await s.deleteExpired!(250, 10)).toBe(1);
    expect((await pg.query('SELECT expires_at FROM fixed_window_counters ORDER BY expires_at')).rows).toEqual([{ expires_at: 300 }, { expires_at: 400 }]);
  });

  it('propagates driver failures', async () => {
    const down = { query: async () => { throw new Error('connection refused'); } };
    await expect(createPostgresStore(down).tryAcquire(r)).rejects.toThrow('connection refused');
  });

  it('validates input before building SQL', async () => {
    const s = createPostgresStore(pg);
    await expect(s.tryAcquire({ ...r, key: 'nope' })).rejects.toBeInstanceOf(FixedWindowError);
    expect(() => createPostgresStore(pg, { table: 'a b' })).toThrow(FixedWindowError);
    expect(() => createPostgresStore(pg, { table: 'a.b.c' })).toThrow(FixedWindowError);
    expect(() => createPostgresStore(pg, { windowType: 'date' as never })).toThrow(FixedWindowError);
    expect(() => createPostgresStore(pg, { retainMs: -1 })).toThrow(FixedWindowError);
  });
});

describe('Postgres store on a table with a timestamptz window, no partition and no expiry column', () => {
  const options = { table: 'ref_auth_limits', columns: { partition: null, expiresAt: null }, windowType: 'timestamptz' as const, retainMs: 2 * 24 * HOUR };

  beforeEach(async () => {
    await pg.query('CREATE TABLE ref_auth_limits (key text NOT NULL, window_start timestamptz NOT NULL, count integer NOT NULL, PRIMARY KEY (key, window_start))');
  });

  it('matches the reference limiter on allow and refuse decisions', async () => {
    const reference = referencePg(pg);
    const limiter = createLimiter({ store: createPostgresStore(pg, options), fingerprintKey: KEY, partition: 'auth' });
    const rule = { windowSeconds: 3600, max: 5 };
    for (let i = 0; i < 9; i += 1) {
      const now = T + i * 1000;
      const expected = await reference(`magic-link-send:ip:203.0.113.5`, rule.windowSeconds, rule.max, now);
      const actual = await limiter.consume({ action: 'magic-link-send:ip', subject: '203.0.113.5', now, policy: { maxAttempts: rule.max, windowMs: rule.windowSeconds * 1000 } });
      expect(actual.allowed, `attempt ${i + 1}`).toBe(expected);
    }
    const next = await referencePg(pg)('magic-link-send:ip:203.0.113.9', 3600, 5, T + 3_600_000);
    expect(next).toBe(true);
  });

  it('differs from the reference in two deliberate ways: it stores a fingerprint and stops counting at the limit', async () => {
    const limiter = createLimiter({ store: createPostgresStore(pg, options), fingerprintKey: KEY, partition: 'auth' });
    for (let i = 0; i < 8; i += 1) await limiter.consume({ action: 'send', subject: 'person@example.test', now: T, policy: { maxAttempts: 5, windowMs: HOUR } });
    const rows = (await pg.query('SELECT key, count FROM ref_auth_limits')).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.count).toBe(5);
    expect(String(rows[0]!.key)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(rows)).not.toContain('person');
    const reference = referencePg(pg, 'ref_raw_limits');
    await pg.query('CREATE TABLE ref_raw_limits (key text NOT NULL, window_start timestamptz NOT NULL, count integer NOT NULL, PRIMARY KEY (key, window_start))');
    for (let i = 0; i < 8; i += 1) await reference('send:person@example.test', 3600, 5, T);
    const raw = (await pg.query('SELECT key, count FROM ref_raw_limits')).rows;
    expect(raw[0]).toEqual({ key: 'send:person@example.test', count: 8 });
  });

  it('peeks without taking an attempt', async () => {
    const limiter = createLimiter({ store: createPostgresStore(pg, options), fingerprintKey: KEY, partition: 'auth' });
    const rule = { maxAttempts: 2, windowMs: HOUR };
    expect((await limiter.peek({ action: 'bearer-fail:ip', subject: '198.51.100.1', now: T, policy: rule })).limited).toBe(false);
    await limiter.consume({ action: 'bearer-fail:ip', subject: '198.51.100.1', now: T, policy: rule });
    await limiter.consume({ action: 'bearer-fail:ip', subject: '198.51.100.1', now: T, policy: rule });
    expect(await limiter.peek({ action: 'bearer-fail:ip', subject: '198.51.100.1', now: T, policy: rule })).toMatchObject({ limited: true, count: 2 });
    expect((await pg.query('SELECT count FROM ref_auth_limits')).rows).toEqual([{ count: 2 }]);
  });

  it('sweeps windows that started before the retention period', async () => {
    const s = createPostgresStore(pg, options);
    const old = { partition: 'auth', key: 'c'.repeat(64), windowStart: T - 3 * 24 * HOUR, expiresAt: T - 3 * 24 * HOUR + HOUR, maxAttempts: 5 };
    const fresh = { ...old, key: 'd'.repeat(64), windowStart: T - HOUR, expiresAt: T };
    await s.tryAcquire(old);
    await s.tryAcquire(fresh);
    expect(await s.deleteExpired!(T, 10)).toBe(1);
    expect((await pg.query('SELECT count(*)::int AS n FROM ref_auth_limits')).rows).toEqual([{ n: 1 }]);
  });

  it('stores the window as a timestamp that matches what a Date parameter would store', async () => {
    const s = createPostgresStore(pg, options);
    const start = Math.floor(T / HOUR) * HOUR;
    await s.tryAcquire({ partition: 'auth', key: 'e'.repeat(64), windowStart: start, expiresAt: start + HOUR, maxAttempts: 5 });
    const same = await pg.query('SELECT count(*)::int AS n FROM ref_auth_limits WHERE window_start = $1::timestamptz', [new Date(start).toISOString()]);
    expect(same.rows).toEqual([{ n: 1 }]);
  });
});

describe('Postgres store with a schema-qualified table and custom columns', () => {
  it('uses them in every statement', async () => {
    await pg.query('CREATE SCHEMA app');
    const options = { table: 'app.limits', columns: { partition: 'scope', key: 'subject_hash', windowStart: 'started_at', expiresAt: 'ends_at', count: 'hits' } };
    await pg.query(postgresCounterSchema(options));
    const s = createPostgresStore(pg, options);
    const r = { partition: 'p', key: 'f'.repeat(64), windowStart: 0, expiresAt: 1000, maxAttempts: 1 };
    expect((await s.tryAcquire(r)).allowed).toBe(true);
    expect((await s.tryAcquire(r)).allowed).toBe(false);
    expect(await s.count!(r)).toBe(1);
    expect(await s.deleteExpired!(1000, 5)).toBe(1);
  });
});
