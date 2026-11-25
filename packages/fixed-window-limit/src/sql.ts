import { FixedWindowError } from './types.js';

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

/** Accepts `name` or `schema.name`. Throws on anything else, so options can be spliced into SQL safely. */
export function tableName(value: string): string {
  const parts = typeof value === 'string' ? value.split('.') : [];
  if (parts.length < 1 || parts.length > 2 || !parts.every((part) => NAME.test(part))) {
    throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: table name');
  }
  return parts.map((part) => `"${part}"`).join('.');
}

export function columnName(value: string): string {
  if (typeof value !== 'string' || !NAME.test(value)) throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: column name');
  return `"${value}"`;
}

export function checkReservation(r: { partition: string; key: string; windowStart: number; expiresAt?: number; maxAttempts?: number }, full: boolean) {
  const bad = typeof r?.partition !== 'string' || typeof r.key !== 'string' || !/^[0-9a-f]{64}$/.test(r.key)
    || !Number.isSafeInteger(r.windowStart) || r.windowStart < 0
    || (full && (!Number.isSafeInteger(r.expiresAt) || (r.expiresAt as number) <= r.windowStart
      || !Number.isSafeInteger(r.maxAttempts) || (r.maxAttempts as number) < 1));
  if (bad) throw new FixedWindowError('invalid_attempt', 'Invalid rate limit reservation');
}
