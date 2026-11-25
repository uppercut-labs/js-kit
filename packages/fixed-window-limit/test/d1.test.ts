import { beforeEach, describe, expect, it } from 'vitest';
import { createD1Store, createLimiter, d1CounterSchema, FixedWindowError } from '../src/index.js';
import { createFakeD1, referenceD1 } from './helpers.js';

const KEY = new Uint8Array(32).fill(9);
const policy = { maxAttempts: 4, windowMs: 60_000 };
const T = 1_700_000_000_000;
const columns = { partition: 'store_id', key: 'fingerprint', windowStart: 'window_start', expiresAt: 'expires_at', count: 'attempts' };
const REF_TABLE = `CREATE TABLE ref_rate_limits (store_id TEXT NOT NULL, fingerprint TEXT NOT NULL, window_start INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, attempts INTEGER NOT NULL, PRIMARY KEY (store_id, fingerprint, window_start))`;

let db: Awaited<ReturnType<typeof createFakeD1>>;
beforeEach(async () => {
  db = await createFakeD1();
  db.exec(REF_TABLE);
});

describe('D1 store beside the reference limiter', () => {
  it('makes the same decisions and leaves the same rows as the reference on its own table', async () => {
    db.exec(REF_TABLE.replace('ref_rate_limits', 'pkg_rate_limits'));
    const reference = referenceD1(db, 'ref_rate_limits');
    const limiter = createLimiter({ store: createD1Store(db, { table: 'pkg_rate_limits', columns }), fingerprintKey: KEY, partition: 'shop-1', policy });
    const plan: Array<[string, number]> = [];
    for (let i = 0; i < 7; i += 1) for (const s of ['a@example.test', 'b@example.test']) plan.push([s, T + i * 9_000]);
    plan.push(['a@example.test', T + 60_000], ['a@example.test', T + 125_000]);
    for (const [subject, now] of plan) {
      const expected = await reference(KEY, policy, { storeId: 'shop-1', action: 'login', subject, now });
      const actual = await limiter.consume({ action: 'login', subject, now });
      expect(actual.allowed, `${subject} at ${now - T}`).toBe(expected.allowed);
      expect(actual.retryAfterMs).toBe(expected.retryAfterMs);
    }
    const dump = (table: string) => db.all(`SELECT store_id, fingerprint, window_start, expires_at, attempts FROM ${table} ORDER BY fingerprint, window_start`);
    expect(dump('pkg_rate_limits')).toEqual(dump('ref_rate_limits'));
    expect(dump('ref_rate_limits').length).toBeGreaterThan(2);
  });

  it('shares one table between both: a reference reservation counts toward the package', async () => {
    const reference = referenceD1(db);
    const limiter = createLimiter({ store: createD1Store(db, { table: 'ref_rate_limits', columns }), fingerprintKey: KEY, partition: 'shop-1', policy });
    for (let i = 0; i < 3; i += 1) await reference(KEY, policy, { storeId: 'shop-1', action: 'login', subject: 'c', now: T });
    const d1 = await limiter.consume({ action: 'login', subject: 'c', now: T });
    const d2 = await limiter.consume({ action: 'login', subject: 'c', now: T });
    expect([d1.allowed, d2.allowed]).toEqual([true, false]);
  });
});

describe('D1 store', () => {
  const store = () => createD1Store(db, { table: 'ref_rate_limits', columns });
  const r = { partition: 'p', key: 'a'.repeat(64), windowStart: 60_000, expiresAt: 120_000, maxAttempts: 2 };

  it('stops raising the counter at the limit', async () => {
    const s = store();
    expect(await s.tryAcquire(r)).toEqual({ allowed: true, count: 1 });
    expect(await s.tryAcquire(r)).toEqual({ allowed: true, count: 2 });
    for (let i = 0; i < 3; i += 1) expect(await s.tryAcquire(r)).toEqual({ allowed: false, count: 2 });
    expect(db.all('SELECT attempts FROM ref_rate_limits')).toEqual([{ attempts: 2 }]);
    expect(await s.count!(r)).toBe(2);
  });

  it('refuses a reservation whose window end disagrees with the stored one', async () => {
    const s = store();
    await s.tryAcquire(r);
    expect((await s.tryAcquire({ ...r, expiresAt: 180_000 })).allowed).toBe(false);
  });

  it('never over-admits when many reservations are in flight', async () => {
    const s = store();
    const results = await Promise.all(Array.from({ length: 25 }, () => s.tryAcquire({ ...r, maxAttempts: 5 })));
    expect(results.filter((x) => x.allowed)).toHaveLength(5);
  });

  it('deletes expired windows oldest first, up to the limit', async () => {
    const s = store();
    for (let i = 0; i < 4; i += 1) await s.tryAcquire({ ...r, key: String(i).repeat(64), windowStart: i * 100, expiresAt: i * 100 + 100 });
    expect(await s.deleteExpired!(250, 2)).toBe(2);
        expect(db.all('SELECT expires_at FROM ref_rate_limits ORDER BY expires_at').map((x) => x.expires_at)).toEqual([300, 400]);
    expect(await s.deleteExpired!(1000, 10)).toBe(2);
  });

  it('propagates database failures so the limiter fails closed', async () => {
    const broken = { prepare: () => ({ bind: () => ({ first: async () => { throw new Error('d1 unavailable'); }, run: async () => ({}) }) }) };
    const limiter = createLimiter({ store: createD1Store(broken), fingerprintKey: KEY, partition: 'p', policy });
    await expect(limiter.consume({ action: 'a', subject: 's', now: T })).rejects.toThrow('d1 unavailable');
  });

  it('validates reservations and names before they reach SQL', async () => {
    const s = store();
    await expect(s.tryAcquire({ ...r, key: 'short' })).rejects.toBeInstanceOf(FixedWindowError);
    await expect(s.tryAcquire({ ...r, expiresAt: r.windowStart })).rejects.toBeInstanceOf(FixedWindowError);
    await expect(s.tryAcquire({ ...r, maxAttempts: 0 })).rejects.toBeInstanceOf(FixedWindowError);
    expect(() => createD1Store(db, { table: 'x; DROP TABLE y' })).toThrow(FixedWindowError);
    expect(() => createD1Store(db, { columns: { count: 'a"b' } })).toThrow(FixedWindowError);
  });

  it('creates its own default table with the schema helper', async () => {
    for (const statement of d1CounterSchema().split(';').map((s) => s.trim()).filter(Boolean)) db.exec(statement);
    const s = createD1Store(db);
    expect(await s.tryAcquire(r)).toEqual({ allowed: true, count: 1 });
    expect(await s.count!(r)).toBe(1);
    expect(await s.deleteExpired!(r.expiresAt, 5)).toBe(1);
  });
});
