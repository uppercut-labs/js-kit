import { FixedWindowError } from './types.js';
import type { CounterStore, FixedWindowPolicy } from './types.js';

export interface SweepOptions {
  /** Chance, from 0 to 1, that a consume also deletes expired windows. */
  readonly probability: number;
  /** Most windows removed per sweep. */
  readonly limit: number;
  /** Random source returning [0, 1). Defaults to Math.random. */
  readonly random?: (() => number) | undefined;
  /** Called when a sweep fails. A failed sweep never fails the request. */
  readonly onError?: ((error: unknown) => void) | undefined;
}

export interface LimiterOptions {
  readonly store: CounterStore;
  /** HMAC key for fingerprints, at least 32 bytes. A string is encoded as UTF-8. */
  readonly fingerprintKey: Uint8Array | string;
  /** Namespace stored in clear next to each fingerprint. Letters, digits and `_ . : -`. */
  readonly partition: string;
  /** Default policy; each call may pass its own. */
  readonly policy?: FixedWindowPolicy | undefined;
  readonly sweep?: SweepOptions | undefined;
}

export interface LimitAttempt {
  /** What is being limited, such as `magic-link-send`. Letters, digits and `_ . : -`. */
  readonly action: string;
  /** Who: a normalized email, client address or account id. At most 2048 characters. Never stored raw. */
  readonly subject: string;
  readonly policy?: FixedWindowPolicy | undefined;
  /** Epoch milliseconds. Defaults to Date.now(). */
  readonly now?: number | undefined;
}

export interface LimitDecision {
  readonly allowed: boolean;
  /** 0 when allowed, otherwise milliseconds until the window ends. */
  readonly retryAfterMs: number;
  /** `retryAfterMs` rounded up to whole seconds, for a Retry-After header. */
  readonly retryAfterSeconds: number;
  readonly limit: number;
  readonly remaining: number;
  /** End of the current window in epoch milliseconds. */
  readonly resetAt: number;
}

export interface PeekDecision {
  readonly limited: boolean;
  readonly count: number;
  readonly remaining: number;
  readonly resetAt: number;
}

export interface Limiter {
  /** Take one attempt. Throws if the store fails or the input is invalid; never allows on error. */
  consume(attempt: LimitAttempt): Promise<LimitDecision>;
  /** Read the window without taking an attempt. Needs a store with `count`. */
  peek(attempt: LimitAttempt): Promise<PeekDecision>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

function validPolicy(policy: unknown): policy is FixedWindowPolicy {
  const p = policy as FixedWindowPolicy | undefined;
  return !!p && Number.isSafeInteger(p.maxAttempts) && p.maxAttempts >= 1
    && Number.isSafeInteger(p.windowMs) && p.windowMs >= 1;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

export function createLimiter(options: LimiterOptions): Limiter {
  const { store, partition, sweep } = options;
  const keyBytes = typeof options.fingerprintKey === 'string'
    ? new TextEncoder().encode(options.fingerprintKey)
    : options.fingerprintKey;
  if (!store || typeof store.tryAcquire !== 'function') {
    throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: a counter store with tryAcquire is required');
  }
  if (!(keyBytes instanceof Uint8Array) || keyBytes.byteLength < 32) {
    throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: fingerprintKey must be at least 32 bytes');
  }
  if (typeof partition !== 'string' || !IDENTIFIER.test(partition)) {
    throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: partition must be 1 to 200 letters, digits or _ . : -');
  }
  if (options.policy !== undefined && !validPolicy(options.policy)) {
    throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: default policy');
  }
  if (sweep && !(sweep.probability >= 0 && sweep.probability <= 1 && Number.isSafeInteger(sweep.limit) && sweep.limit >= 1)) {
    throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: sweep options');
  }
  const secret = Uint8Array.from(keyBytes);
  let cryptoKey: Promise<CryptoKey> | undefined;
  const importKey = () => (cryptoKey ??= crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));

  async function prepare(attempt: LimitAttempt) {
    const policy = attempt?.policy ?? options.policy;
    const now = attempt?.now ?? Date.now();
    if (!attempt || !validPolicy(policy)) throw new FixedWindowError('invalid_attempt', 'Invalid rate limit attempt: policy missing or invalid');
    if (typeof attempt.action !== 'string' || !IDENTIFIER.test(attempt.action)
      || typeof attempt.subject !== 'string' || attempt.subject.length === 0 || attempt.subject.length > 2048
      || !Number.isSafeInteger(now) || now < 0) {
      throw new FixedWindowError('invalid_attempt', 'Invalid rate limit attempt: action, subject or time');
    }
    const windowStart = Math.floor(now / policy.windowMs) * policy.windowMs;
    const expiresAt = windowStart + policy.windowMs;
    if (!Number.isSafeInteger(expiresAt)) throw new FixedWindowError('invalid_attempt', 'Invalid rate limit window expiration');
    const payload = new TextEncoder().encode(JSON.stringify([partition, attempt.action, attempt.subject]));
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', await importKey(), payload));
    return { policy, now, windowStart, expiresAt, key: toHex(digest) };
  }

  async function maybeSweep(now: number) {
    if (!sweep || typeof store.deleteExpired !== 'function') return;
    if ((sweep.random ?? Math.random)() >= sweep.probability) return;
    try {
      await store.deleteExpired(now, sweep.limit);
    } catch (error) {
      sweep.onError?.(error);
    }
  }

  return {
    async consume(attempt) {
      const { policy, now, windowStart, expiresAt, key } = await prepare(attempt);
      const result = await store.tryAcquire({ partition, key, windowStart, expiresAt, maxAttempts: policy.maxAttempts });
      if (!result || typeof result.allowed !== 'boolean' || !Number.isSafeInteger(result.count) || result.count < 0) {
        throw new FixedWindowError('invalid_store_result', 'Rate limit counter returned an invalid result');
      }
      await maybeSweep(now);
      const retryAfterMs = result.allowed ? 0 : Math.max(0, expiresAt - now);
      return {
        allowed: result.allowed,
        retryAfterMs,
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        limit: policy.maxAttempts,
        remaining: Math.max(0, policy.maxAttempts - result.count),
        resetAt: expiresAt,
      };
    },
    async peek(attempt) {
      if (typeof store.count !== 'function') {
        throw new FixedWindowError('unsupported_store', 'This rate limit counter cannot read a window without taking an attempt');
      }
      const { policy, windowStart, expiresAt, key } = await prepare(attempt);
      const count = await store.count({ partition, key, windowStart });
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new FixedWindowError('invalid_store_result', 'Rate limit counter returned an invalid count');
      }
      return { limited: count >= policy.maxAttempts, count, remaining: Math.max(0, policy.maxAttempts - count), resetAt: expiresAt };
    },
  };
}
