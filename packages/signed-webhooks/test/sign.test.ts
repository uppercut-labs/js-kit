import { describe, expect, it } from 'vitest';
import { buildEnvelope, parseTimestamp, signWebhook, signWebhookHeader, timingSafeEqual, verifyWebhook, WebhookError } from '../src/index.js';
import { referenceInternal } from './references.js';

const SECRET = 'synthetic-endpoint-secret';
const ISO = '2026-09-21T00:00:00.000Z';
const BODY = '{"event_id":"abc"}';
const NOW = Date.parse(ISO);

describe('signWebhook', () => {
  it('matches an independent HMAC-SHA256 of timestamp.body', async () => {
    // Computed with: printf '<ts>.<body>' | openssl dgst -sha256 -hmac <secret>
    expect(await signWebhook(SECRET, ISO, BODY)).toBe('03625b2033e919a913d62a04e217aa6ce62a420f317502413ddecb5d73b1c6d0');
    expect(await signWebhookHeader(SECRET, ISO, BODY)).toBe('sha256=03625b2033e919a913d62a04e217aa6ce62a420f317502413ddecb5d73b1c6d0');
  });

  it('matches the reference signer for strings, bytes and unicode', async () => {
    for (const body of ['', 'plain', '{"emoji":"\u{1F600}","k":"é"}', 'a'.repeat(5000)]) {
      for (const ts of [ISO, '1700000000', '0']) {
        expect(await signWebhook(SECRET, ts, body)).toBe(referenceInternal.sign(SECRET, ts, body));
        expect(await signWebhook(SECRET, ts, new TextEncoder().encode(body))).toBe(referenceInternal.sign(SECRET, ts, body));
      }
    }
    expect(await signWebhook(SECRET, 1700000000, 'x')).toBe(await signWebhook(SECRET, '1700000000', 'x'));
  });

  it('rejects an empty secret', async () => {
    await expect(signWebhook('', ISO, BODY)).rejects.toBeInstanceOf(WebhookError);
  });
});

describe('verifyWebhook', () => {
  it('accepts the signature with or without the sha256= prefix and agrees with the reference', async () => {
    const hex = referenceInternal.sign(SECRET, ISO, BODY);
    for (const sig of [hex, `sha256=${hex}`, hex.toUpperCase(), ` sha256=${hex} `]) {
      const result = await verifyWebhook(SECRET, ISO, BODY, sig, { now: NOW });
      expect(result).toEqual({ ok: true, secretIndex: 0, timestampMs: NOW });
    }
    expect(referenceInternal.verify(SECRET, ISO, BODY, `sha256=${hex}`)).toBe(true);
  });

  it('refuses what the reference refuses: wrong secret, changed body, changed timestamp, truncated signature', async () => {
    const hex = referenceInternal.sign(SECRET, ISO, BODY);
    const cases: Array<[string, string, string, string]> = [
      ['other-secret', ISO, BODY, hex],
      [SECRET, ISO, `${BODY} `, hex],
      [SECRET, '2026-09-21T00:00:01.000Z', BODY, hex],
      [SECRET, ISO, BODY, hex.slice(0, 62)],
      [SECRET, ISO, BODY, `${hex.slice(0, 63)}${hex.endsWith("1") ? "2" : "1"}`],
    ];
    for (const [secret, ts, body, sig] of cases) {
      expect(referenceInternal.verify(secret, ts, body, sig), `${secret} ${ts} ${sig.slice(-4)}`).toBe(false);
      const result = await verifyWebhook(secret, ts, body, sig, { toleranceSeconds: null });
      expect(result.ok).toBe(false);
    }
  });

  it('applies the tolerance both ways and reports why', async () => {
    const sig = await signWebhookHeader(SECRET, ISO, BODY);
    const at = (offsetMs: number) => verifyWebhook(SECRET, ISO, BODY, sig, { now: NOW + offsetMs });
    expect((await at(300_000)).ok).toBe(true);
    expect((await at(-300_000)).ok).toBe(true);
    expect(await at(300_001)).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
    expect(await at(-300_001)).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
    expect((await verifyWebhook(SECRET, ISO, BODY, sig, { now: NOW + 3_600_000, toleranceSeconds: 7200 })).ok).toBe(true);
    expect((await verifyWebhook(SECRET, ISO, BODY, sig, { now: NOW + 86_400_000, toleranceSeconds: null })).ok).toBe(true);
    expect((await verifyWebhook(SECRET, ISO, BODY, sig, { now: new Date(NOW) })).ok).toBe(true);
  });

  it('reads unix-second timestamps and refuses unreadable ones', async () => {
    const sig = await signWebhook(SECRET, 1700000000, BODY);
    expect((await verifyWebhook(SECRET, 1700000000, BODY, sig, { now: 1700000100_000 })).ok).toBe(true);
    expect((await verifyWebhook(SECRET, '1700000000', BODY, sig, { now: 1700000100_000 })).ok).toBe(true);
    expect(await verifyWebhook(SECRET, 'yesterday', BODY, sig)).toEqual({ ok: false, reason: 'invalid_timestamp' });
    expect(await verifyWebhook(SECRET, '', BODY, sig)).toEqual({ ok: false, reason: 'invalid_timestamp' });
    expect(parseTimestamp(1.5)).toBeNull();
    expect(parseTimestamp(-1)).toBeNull();
    expect(parseTimestamp('1700000000')).toBe(1700000000_000);
    expect(parseTimestamp(ISO)).toBe(NOW);
  });

  it('reports a missing or malformed signature without computing a MAC', async () => {
    for (const sig of [undefined, null, '', '   ', []]) {
      expect(await verifyWebhook(SECRET, ISO, BODY, sig as never, { now: NOW })).toEqual({ ok: false, reason: 'missing_signature' });
    }
    for (const sig of ['sha256=', 'nothex', 'sha256=zz', 'ab'.repeat(31), 'ab'.repeat(33)]) {
      expect(await verifyWebhook(SECRET, ISO, BODY, sig, { now: NOW })).toEqual({ ok: false, reason: 'malformed_signature' });
    }
    expect(await verifyWebhook(SECRET, ISO, BODY, Array.from({ length: 33 }, () => 'ab'.repeat(32)), { now: NOW })).toEqual({ ok: false, reason: 'malformed_signature' });
  });

  it('tries every secret and signature and says which secret matched', async () => {
    const good = await signWebhook('secret-two', ISO, BODY);
    const bad = 'ab'.repeat(32);
    expect(await verifyWebhook(['secret-one', 'secret-two'], ISO, BODY, [bad, good], { now: NOW })).toMatchObject({ ok: true, secretIndex: 1 });
    expect(await verifyWebhook(['secret-one', 'secret-three'], ISO, BODY, good, { now: NOW })).toEqual({ ok: false, reason: 'no_matching_signature' });
    await expect(verifyWebhook([], ISO, BODY, good)).rejects.toBeInstanceOf(WebhookError);
  });

  it('takes the body as bytes and signs exactly those bytes', async () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x7b]);
    const sig = await signWebhook(SECRET, ISO, bytes);
    expect((await verifyWebhook(SECRET, ISO, bytes, sig, { now: NOW })).ok).toBe(true);
    expect((await verifyWebhook(SECRET, ISO, new Uint8Array([0xff, 0xfe, 0x00, 0x7c]), sig, { now: NOW })).ok).toBe(false);
  });

  it('rejects a bad tolerance instead of silently skipping the check', async () => {
    const sig = await signWebhook(SECRET, ISO, BODY);
    await expect(verifyWebhook(SECRET, ISO, BODY, sig, { toleranceSeconds: -1 })).rejects.toBeInstanceOf(WebhookError);
    await expect(verifyWebhook(SECRET, ISO, BODY, sig, { toleranceSeconds: Number.NaN })).rejects.toBeInstanceOf(WebhookError);
  });
});

describe('timingSafeEqual', () => {
  it('compares strings and bytes', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(timingSafeEqual('a', new Uint8Array([97]))).toBe(true);
  });
});

describe('buildEnvelope', () => {
  it('serializes to the same bytes as the envelope it replaces', () => {
    const item = { id: 'fb_1', projectId: 'p_1', projectSlug: 'demo', projectName: 'Demo' };
    const event = { id: 'ev_1', eventType: 'feedback.created', createdAt: ISO, payload: { note: 'hello', n: [1, 2] } };
    const mine = buildEnvelope({
      id: event.id,
      type: event.eventType,
      occurredAt: event.createdAt,
      extra: { project: { id: item.projectId, slug: item.projectSlug, name: item.projectName }, feedback_id: item.id },
      data: event.payload,
    });
    expect(JSON.stringify(mine)).toBe(JSON.stringify(referenceInternal.envelope(item, event)));
  });

  it('refuses extras that would overwrite the fixed fields', () => {
    for (const key of ['schema_version', 'event_id', 'event_type', 'occurred_at', 'data']) {
      expect(() => buildEnvelope({ id: 'a', type: 'b', occurredAt: ISO, data: null, extra: { [key]: 1 } })).toThrow(WebhookError);
    }
    expect(buildEnvelope({ id: 'a', type: 'b', occurredAt: ISO, data: null })).toEqual({ schema_version: 1, event_id: 'a', event_type: 'b', occurred_at: ISO, data: null });
  });
});
