export interface FixedWindowPolicy {
  /** Attempts allowed per window. A positive safe integer. */
  readonly maxAttempts: number;
  /** Window length in milliseconds. A positive safe integer. */
  readonly windowMs: number;
}

/** One attempt to take a slot in one window of one fingerprint. */
export interface Reservation {
  /** Namespace such as a store, tenant or environment. Stored in clear. */
  readonly partition: string;
  /** Hex HMAC fingerprint of partition, action and subject. The raw subject never reaches a store. */
  readonly key: string;
  /** Start of the window in epoch milliseconds. */
  readonly windowStart: number;
  /** End of the window in epoch milliseconds. */
  readonly expiresAt: number;
  readonly maxAttempts: number;
}

export interface AcquireResult {
  readonly allowed: boolean;
  /** Attempts recorded in this window after the call. Equals maxAttempts when the attempt was refused. */
  readonly count: number;
}

/**
 * Where counters live. Every instance of a service must share one store.
 * Implementations throw when storage fails: the limiter never lets a request through on an error.
 */
export interface CounterStore {
  /**
   * Atomically take one slot only while the window holds fewer than `maxAttempts`.
   * A refused attempt must not raise the counter.
   */
  tryAcquire(reservation: Reservation): Promise<AcquireResult>;
  /** Attempts recorded for a window without taking one. */
  count?(window: Pick<Reservation, 'partition' | 'key' | 'windowStart'>): Promise<number>;
  /** Delete up to `limit` windows that ended at or before `now`. Returns how many were removed. */
  deleteExpired?(now: number, limit: number): Promise<number>;
}

export type FixedWindowErrorCode = 'invalid_config' | 'invalid_attempt' | 'invalid_store_result' | 'unsupported_store';

export class FixedWindowError extends Error {
  readonly code: FixedWindowErrorCode;
  constructor(code: FixedWindowErrorCode, message: string) {
    super(message);
    this.name = 'FixedWindowError';
    this.code = code;
  }
}
