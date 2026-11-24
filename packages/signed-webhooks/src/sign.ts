import { bytesToHex, hexToBytes, hmacKey, signedMessage, WebhookError } from './bytes.js';
import type { Body, Secret } from './bytes.js';

export type VerifyFailure =
  | 'missing_signature'
  | 'malformed_signature'
  | 'invalid_timestamp'
  | 'timestamp_outside_tolerance'
  | 'no_matching_signature';

export type VerifyResult =
  | { readonly ok: true; /** Index of the secret that matched. */ readonly secretIndex: number; /** Signed time, epoch milliseconds, when it could be read. */ readonly timestampMs: number | null }
  | { readonly ok: false; readonly reason: VerifyFailure };

export interface VerifyOptions {
  /** Largest allowed distance between the signed time and now, either way. Default 300. `null` skips the check. */
  readonly toleranceSeconds?: number | null;
  /** Epoch milliseconds, or a Date. Defaults to the current time. */
  readonly now?: number | Date;
}

/** HMAC-SHA256 over `${timestamp}.${body}`, as lower-case hex. */
export async function signWebhook(secret: Secret, timestamp: string | number, body: Body): Promise<string> {
  const key = await hmacKey(secret, 'sign');
  return bytesToHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, signedMessage(timestamp, body))));
}

/** The value for a signature header: `sha256=` and the hex digest. */
export async function signWebhookHeader(secret: Secret, timestamp: string | number, body: Body): Promise<string> {
  return `sha256=${await signWebhook(secret, timestamp, body)}`;
}

/** Digits are unix seconds; anything else must be a date string such as an ISO timestamp. */
export function parseTimestamp(value: string | number): number | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? value * 1000 : null;
  if (typeof value !== 'string' || value.length === 0) return null;
  if (/^\d{1,15}$/.test(value)) return Number(value) * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

const MAX_SIGNATURES = 32;

/** Check candidate hex digests against every secret. Constant-time per comparison (Web Crypto verify). */
export async function matchSignature(
  secrets: readonly Secret[],
  timestamp: string | number,
  body: Body,
  digests: readonly Uint8Array<ArrayBuffer>[],
): Promise<number> {
  const message = signedMessage(timestamp, body);
  const keys = await Promise.all(secrets.map((secret) => hmacKey(secret, 'verify')));
  const matches = await Promise.all(keys.map(async (key) => {
    const each = await Promise.all(digests.map((digest) => crypto.subtle.verify('HMAC', key, digest, message)));
    return each.some(Boolean);
  }));
  return matches.indexOf(true);
}

/**
 * Verify a signature header against the timestamp and raw body that were signed.
 * Accepts `sha256=<hex>` or bare hex, one or several signatures, one or several secrets
 * (rotation, or separate live and test secrets). Always pass the exact bytes received, not re-serialized JSON.
 */
export async function verifyWebhook(
  secrets: Secret | readonly Secret[],
  timestamp: string | number,
  body: Body,
  signature: string | readonly string[] | null | undefined,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  const secretList: readonly Secret[] = typeof secrets === 'string' || secrets instanceof Uint8Array ? [secrets] : secrets;
  if (secretList.length === 0) throw new WebhookError('invalid_secret', 'At least one webhook secret is required');
  const raw = signature == null ? [] : typeof signature === 'string' ? [signature] : [...signature];
  if (raw.length === 0 || raw.every((s) => typeof s !== 'string' || s.trim() === '')) return { ok: false, reason: 'missing_signature' };
  if (raw.length > MAX_SIGNATURES) return { ok: false, reason: 'malformed_signature' };
  const digests: Uint8Array<ArrayBuffer>[] = [];
  for (const value of raw) {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    const hex = trimmed.startsWith('sha256=') ? trimmed.slice('sha256='.length) : trimmed;
    const bytes = hex.length === 64 ? hexToBytes(hex) : null;
    if (bytes) digests.push(bytes);
  }
  if (digests.length === 0) return { ok: false, reason: 'malformed_signature' };

  const tolerance = options.toleranceSeconds === undefined ? 300 : options.toleranceSeconds;
  const timestampMs = parseTimestamp(timestamp);
  if (tolerance !== null) {
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new WebhookError('invalid_input', 'toleranceSeconds must be a non-negative number or null');
    if (timestampMs === null) return { ok: false, reason: 'invalid_timestamp' };
    const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
    if (Math.abs(now - timestampMs) > tolerance * 1000) return { ok: false, reason: 'timestamp_outside_tolerance' };
  }
  const secretIndex = await matchSignature(secretList, timestamp, body, digests);
  return secretIndex === -1 ? { ok: false, reason: 'no_matching_signature' } : { ok: true, secretIndex, timestampMs };
}
