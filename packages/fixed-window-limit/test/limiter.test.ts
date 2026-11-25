import { describe, expect, it } from 'vitest';
import { createLimiter, createMemoryStore, FixedWindowError } from '../src/index.js';
import type { CounterStore } from '../src/index.js';

const KEY = new Uint8Array(32).fill(7);
const policy = { maxAttempts: 3, windowMs: 60_000 };
const T = 1_700_000_000_000;

function make(store: CounterStore = createMemoryStore(), extra: object = {}) {
  return createLimiter({ store, fingerprintKey: KEY, partition: 'store-a', policy, ...extra });
}

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof FixedWindowError ? error.code : `other:${String(error)}`;
  }
  return 'ok';
}

describe('consume', () => {
  it('allows up to the limit, then refuses until the window ends', async () => {
    const limiter = make();
    const windowStart = Math.floor(T / 60_000) * 60_000;
    const results = [];
    for (let i = 0; i < 5; i += 1) results.push(await limiter.consume({ action: 'login', subject: 'a@example.test', now: T + i }));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results.map((r) => r.remaining)).toEqual([2, 1, 0, 0, 0]);
    expect(results[3]!.retryAfterMs).toBe(windowStart + 60_000 - (T + 3));
    expect(results[3]!.retryAfterSeconds).toBe(Math.ceil(results[3]!.retryAfterMs / 1000));
    expect(results[3]!.resetAt).toBe(windowStart + 60_000);
    expect(results[0]!.retryAfterMs).toBe(0);
    const next = await limiter.consume({ action: 'login', subject: 'a@example.test', now: windowStart + 60_000 });
    expect(next.allowed).toBe(true);
  });

  it('keeps subjects, actions and partitions apart', async () => {
    const store = createMemoryStore();
    const a = make(store);
    const b = createLimiter({ store, fingerprintKey: KEY, partition: 'store-b', policy });
    for (let i = 0; i < 3; i += 1) await a.consume({ action: 'login', subject: 'x', now: T });
    expect((await a.consume({ action: 'login', subject: 'x', now: T })).allowed).toBe(false);
    expect((await a.consume({ action: 'login', subject: 'y', now: T })).allowed).toBe(true);
    expect((await a.consume({ action: 'reset', subject: 'x', now: T })).allowed).toBe(true);
    expect((await b.consume({ action: 'login', subject: 'x', now: T })).allowed).toBe(true);
  });

  it('takes a policy per call and rejects a missing one', async () => {
    const bare = createLimiter({ store: createMemoryStore(), fingerprintKey: KEY, partition: 'p' });
    expect(await reason(bare.consume({ action: 'a', subject: 's' }))).toBe('invalid_attempt');
    const one = await bare.consume({ action: 'a', subject: 's', now: T, policy: { maxAttempts: 1, windowMs: 1000 } });
    const two = await bare.consume({ action: 'a', subject: 's', now: T, policy: { maxAttempts: 1, windowMs: 1000 } });
    expect([one.allowed, two.allowed]).toEqual([true, false]);
  });

  it('never lets more than the limit through when calls race', async () => {
    const limiter = make();
    const results = await Promise.all(Array.from({ length: 20 }, () => limiter.consume({ action: 'a', subject: 's', now: T })));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
  });

  it('hands the store only a hex fingerprint, never the subject', async () => {
    const seen: unknown[] = [];
    const inner = createMemoryStore();
    const spy: CounterStore = { tryAcquire: (r) => (seen.push(r), inner.tryAcquire(r)) };
    await make(spy).consume({ action: 'login', subject: 'person@example.test', now: T });
    expect(JSON.stringify(seen)).not.toContain('person');
    expect(seen[0]).toMatchObject({ partition: 'store-a', maxAttempts: 3 });
    expect((seen[0] as { key: string }).key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives the fingerprint from HMAC-SHA256 over the JSON of partition, action and subject', async () => {
    const seen: string[] = [];
    const spy: CounterStore = { tryAcquire: async (r) => (seen.push(r.key), { allowed: true, count: 1 }) };
    await make(spy).consume({ action: 'login', subject: 'x', now: T });
    const key = await crypto.subtle.importKey('raw', KEY, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('["store-a","login","x"]')));
    expect(seen[0]).toBe([...mac].map((b) => b.toString(16).padStart(2, '0')).join(''));
    const other = createLimiter({ store: spy, fingerprintKey: new Uint8Array(32).fill(8), partition: 'store-a', policy });
    await other.consume({ action: 'login', subject: 'x', now: T });
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('accepts a string key of at least 32 bytes', async () => {
    const limiter = createLimiter({ store: createMemoryStore(), fingerprintKey: 'k'.repeat(32), partition: 'p', policy });
    expect((await limiter.consume({ action: 'a', subject: 's' })).allowed).toBe(true);
  });
});

describe('fail closed', () => {
  it('rethrows a store failure instead of allowing', async () => {
    const broken: CounterStore = { tryAcquire: async () => { throw new Error('storage down'); } };
    await expect(make(broken).consume({ action: 'a', subject: 's', now: T })).rejects.toThrow('storage down');
  });

  it('rejects malformed store answers', async () => {
    for (const answer of [undefined, null, true, { allowed: 'yes', count: 1 }, { allowed: true, count: -1 }, { allowed: true }]) {
      const odd = { tryAcquire: async () => answer } as unknown as CounterStore;
      expect(await reason(make(odd).consume({ action: 'a', subject: 's', now: T }))).toBe('invalid_store_result');
    }
  });

  it('rejects bad configuration', () => {
    const base = { store: createMemoryStore(), fingerprintKey: KEY, partition: 'p' };
    expect(() => createLimiter({ ...base, fingerprintKey: new Uint8Array(31) })).toThrow(FixedWindowError);
    expect(() => createLimiter({ ...base, fingerprintKey: 'short' })).toThrow(FixedWindowError);
    expect(() => createLimiter({ ...base, partition: 'bad space' })).toThrow(FixedWindowError);
    expect(() => createLimiter({ ...base, policy: { maxAttempts: 0, windowMs: 1 } })).toThrow(FixedWindowError);
    expect(() => createLimiter({ ...base, policy: { maxAttempts: 1, windowMs: 1.5 } })).toThrow(FixedWindowError);
    expect(() => createLimiter({ ...base, store: {} as CounterStore })).toThrow(FixedWindowError);
    expect(() => createLimiter({ ...base, sweep: { probability: 2, limit: 1 } })).toThrow(FixedWindowError);
  });

  it('rejects bad attempts', async () => {
    const limiter = make();
    const bad = [
      { action: '', subject: 's' },
      { action: 'has space', subject: 's' },
      { action: 'a', subject: '' },
      { action: 'a', subject: 'x'.repeat(2049) },
      { action: 'a', subject: 's', now: -1 },
      { action: 'a', subject: 's', now: 1.5 },
      { action: 'a', subject: 's', policy: { maxAttempts: 1, windowMs: Number.MAX_SAFE_INTEGER } , now: Number.MAX_SAFE_INTEGER },
    ];
    for (const attempt of bad) expect(await reason(limiter.consume(attempt))).toBe('invalid_attempt');
  });
});

describe('peek', () => {
  it('reads a window without taking an attempt', async () => {
    const limiter = make();
    expect(await limiter.peek({ action: 'a', subject: 's', now: T })).toMatchObject({ limited: false, count: 0, remaining: 3 });
    for (let i = 0; i < 3; i += 1) await limiter.consume({ action: 'a', subject: 's', now: T });
    expect(await limiter.peek({ action: 'a', subject: 's', now: T })).toMatchObject({ limited: true, count: 3, remaining: 0 });
    expect(await limiter.peek({ action: 'a', subject: 's', now: T })).toMatchObject({ limited: true, count: 3 });
  });

  it('refuses when the store cannot count', async () => {
    const store: CounterStore = { tryAcquire: async () => ({ allowed: true, count: 1 }) };
    expect(await reason(make(store).peek({ action: 'a', subject: 's', now: T }))).toBe('unsupported_store');
  });
});

describe('sweep', () => {
  const sweepOptions = (random: () => number, onError?: (e: unknown) => void) => ({ sweep: { probability: 0.5, limit: 10, random, onError } });

  it('deletes expired windows when the dice say so, and only then', async () => {
    const store = createMemoryStore();
    await make(store).consume({ action: 'a', subject: 'old', now: T });
    expect(store.size).toBe(1);
    const later = T + 10 * 60_000;
    await make(store, sweepOptions(() => 0.9)).consume({ action: 'a', subject: 'new', now: later });
    expect(store.size).toBe(2);
    await make(store, sweepOptions(() => 0.1)).consume({ action: 'a', subject: 'new2', now: later });
    expect(store.size).toBe(2); // old window removed, two live windows remain
  });

  it('does not fail the request when the sweep fails', async () => {
    const errors: unknown[] = [];
    const inner = createMemoryStore();
    const store: CounterStore = { ...inner, tryAcquire: (r) => inner.tryAcquire(r), deleteExpired: async () => { throw new Error('sweep failed'); } };
    const decision = await make(store, sweepOptions(() => 0, (e) => errors.push(e))).consume({ action: 'a', subject: 's', now: T });
    expect(decision.allowed).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe('memory store', () => {
  it('counts, refuses without raising the counter, and deletes by expiry', async () => {
    const store = createMemoryStore();
    const r = { partition: 'p', key: 'k'.repeat(64), windowStart: 0, expiresAt: 100, maxAttempts: 2 };
    expect(await store.tryAcquire(r)).toEqual({ allowed: true, count: 1 });
    expect(await store.tryAcquire(r)).toEqual({ allowed: true, count: 2 });
    expect(await store.tryAcquire(r)).toEqual({ allowed: false, count: 2 });
    expect(await store.count!(r)).toBe(2);
    expect(await store.tryAcquire({ ...r, expiresAt: 200 })).toEqual({ allowed: false, count: 2 });
    expect(await store.deleteExpired!(99, 5)).toBe(0);
    expect(await store.deleteExpired!(100, 5)).toBe(1);
    expect(await store.count!(r)).toBe(0);
  });
});
