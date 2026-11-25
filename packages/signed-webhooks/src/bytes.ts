const encoder = new TextEncoder();

export type Secret = string | Uint8Array;
export type Body = string | Uint8Array;

export class WebhookError extends Error {
  readonly code: 'invalid_secret' | 'invalid_input' | 'storage_conflict';
  constructor(code: WebhookError['code'], message: string) {
    super(message);
    this.name = 'WebhookError';
    this.code = code;
  }
}

/** Bytes of a string (UTF-8) or a copy of a byte array, so callers cannot change it mid-verification. */
export function toBytes(value: Body): Uint8Array<ArrayBuffer> {
  return typeof value === 'string' ? encoder.encode(value) : new Uint8Array(value);
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** Strict lower or upper case hex of even length; returns null for anything else. */
export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (typeof hex !== 'string' || hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/**
 * Compare two strings or byte arrays without stopping at the first difference.
 * Different lengths are unequal; the loop still runs over the longer input.
 */
export function timingSafeEqual(a: Body, b: Body): boolean {
  const x = toBytes(a);
  const y = toBytes(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i += 1) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function hmacKey(secret: Secret, usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const raw = toBytes(secret);
  if (raw.length === 0) throw new WebhookError('invalid_secret', 'A webhook secret must not be empty');
  return crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);
}

/** The signed message: `${timestamp}.` followed by the raw body bytes. */
export function signedMessage(timestamp: string | number, body: Body): Uint8Array<ArrayBuffer> {
  const prefix = encoder.encode(`${timestamp}.`);
  const raw = toBytes(body);
  const out = new Uint8Array(prefix.length + raw.length);
  out.set(prefix);
  out.set(raw, prefix.length);
  return out;
}
