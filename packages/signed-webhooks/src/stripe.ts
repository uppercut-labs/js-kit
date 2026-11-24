import { hexToBytes } from './bytes.js';
import type { Body, Secret } from './bytes.js';
import { matchSignature, signWebhook } from './sign.js';

export type StripeFailure = 'missing_header' | 'malformed_header' | 'timestamp_outside_tolerance' | 'no_matching_signature';

export type StripeResult =
  | { readonly ok: true; /** Signed time in unix seconds. */ readonly timestamp: number; readonly secretIndex: number }
  | { readonly ok: false; readonly reason: StripeFailure };

export interface StripeVerifyOptions {
  /** Default 300, Stripe's own default. */
  readonly toleranceSeconds?: number;
  /** Epoch milliseconds or a Date. Defaults to the current time. */
  readonly now?: number | Date;
}

const MAX_SIGNATURES = 32;

/** Build a `Stripe-Signature` value: `t=<unix seconds>,v1=<hex>`. For tests and mocks; Stripe signs real events. */
export async function signStripeHeader(secret: Secret, body: Body, timestampSeconds: number): Promise<string> {
  return `t=${timestampSeconds},v1=${await signWebhook(secret, timestampSeconds, body)}`;
}

/**
 * Verify a `Stripe-Signature` header the way Stripe documents it: HMAC-SHA256 of `${t}.${payload}` under the
 * endpoint secret, any `v1` entry may match, the timestamp must be within the tolerance. Pass several secrets
 * to accept more than one endpoint or a rotating secret; `secretIndex` says which one matched.
 * `payload` must be the raw request body, not parsed and re-serialized JSON.
 * Unknown schemes such as `v0` are ignored. A repeated `t`, a missing `t`, or no well-formed `v1` is malformed.
 */
export async function verifyStripeSignature(
  payload: Body,
  header: string | null | undefined,
  secrets: Secret | readonly Secret[],
  options: StripeVerifyOptions = {},
): Promise<StripeResult> {
  if (typeof header !== 'string' || header.trim() === '') return { ok: false, reason: 'missing_header' };
  if (header.length > 8192) return { ok: false, reason: 'malformed_header' };
  let timestamp: number | undefined;
  const digests: Uint8Array<ArrayBuffer>[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (name === 't') {
      if (timestamp !== undefined || !/^(0|[1-9][0-9]{0,14})$/.test(value)) return { ok: false, reason: 'malformed_header' };
      timestamp = Number(value);
    } else if (name === 'v1') {
      const bytes = value.length === 64 ? hexToBytes(value) : null;
      if (bytes) digests.push(bytes);
    }
  }
  if (timestamp === undefined || digests.length === 0 || digests.length > MAX_SIGNATURES) return { ok: false, reason: 'malformed_header' };
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now instanceof Date ? options.now.getTime() : options.now ?? Date.now();
  if (Math.abs(now - timestamp * 1000) > tolerance * 1000) return { ok: false, reason: 'timestamp_outside_tolerance' };
  const list: readonly Secret[] = typeof secrets === 'string' || secrets instanceof Uint8Array ? [secrets] : secrets;
  const secretIndex = await matchSignature(list, timestamp, payload, digests);
  return secretIndex === -1 ? { ok: false, reason: 'no_matching_signature' } : { ok: true, timestamp, secretIndex };
}
