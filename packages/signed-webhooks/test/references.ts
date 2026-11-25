/**
 * Reference copies of the verifiers this package replaces, kept so the package can be run beside them.
 * They are written out here as they behaved, quirks included.
 */
import { createHmac, timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto';

/** HMAC over `${timestamp}.${body}` with Node crypto; the signature may carry a `sha256=` prefix. */
export const referenceInternal = {
  sign(secret: string, timestamp: string, rawBody: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  },
  verify(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
    const expected = referenceInternal.sign(secret, timestamp, rawBody);
    const provided = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature;
    const a = Buffer.from(expected);
    const b = Buffer.from(provided);
    if (a.length !== b.length) return false;
    return nodeTimingSafeEqual(a, b);
  },
  envelope(item: { projectId: string; projectSlug: string; projectName: string; id: string }, event: { id: string; eventType: string; createdAt: string; payload: unknown }) {
    return {
      schema_version: 1,
      event_id: event.id,
      event_type: event.eventType,
      occurred_at: event.createdAt,
      project: { id: item.projectId, slug: item.projectSlug, name: item.projectName },
      feedback_id: item.id,
      data: event.payload,
    };
  },
};

/** A Workers handler's inline Stripe check: lenient header parsing, two secrets, hand-written compare. */
export async function referenceWorkerStripe(secrets: string[], payload: string, header: string, nowMs: number): Promise<{ verifiedBy: string | null }> {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]).filter((kv) => kv.length === 2));
  const signatures = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || !signatures.length || Math.abs(nowMs / 1000 - t) > 300) return { verifiedBy: null };
  let verifiedBy: string | null = null;
  const timingSafeEqual = (a: string, b: string) => {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
  };
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
    const expected = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
    if (signatures.some((s) => s.length === expected.length && timingSafeEqual(s, expected))) verifiedBy ??= secret;
  }
  return { verifiedBy };
}

/** A strict Stripe v1 check: every part must be well formed, one `t`, WebCrypto verify, 300 s window. */
export async function referenceStrictStripe(secret: string, body: Uint8Array, header: string, nowSeconds: number): Promise<boolean> {
  if (typeof header !== 'string' || header.length > 8192) return false;
  let timestamp: string | undefined;
  const signatures: Uint8Array<ArrayBuffer>[] = [];
  for (const rawPart of header.split(',')) {
    const part = rawPart.trim();
    const separator = part.indexOf('=');
    const prefix = part.slice(0, separator);
    const value = part.slice(separator + 1);
    if (prefix === 't') {
      if (timestamp !== undefined || !/^(0|[1-9][0-9]*)$/.test(value)) return false;
      timestamp = value;
    } else if (prefix === 'v1') {
      if (!/^[a-fA-F0-9]{64}$/.test(value)) return false;
      const bytes = new Uint8Array(32);
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
      signatures.push(bytes);
    }
  }
  if (timestamp === undefined || signatures.length === 0 || signatures.length > 64) return false;
  const signedAt = Number(timestamp);
  if (!Number.isSafeInteger(signedAt) || Math.abs(nowSeconds - signedAt) > 300) return false;
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signedPayload = new Uint8Array(prefix.length + body.length);
  signedPayload.set(prefix);
  signedPayload.set(body, prefix.length);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const matches = await Promise.all(signatures.map((signature) => crypto.subtle.verify('HMAC', key, signature, signedPayload)));
  return matches.some(Boolean);
}
