import { describe, expect, it } from 'vitest';
import { signStripeHeader, signWebhook, verifyStripeSignature } from '../src/index.js';
import { referenceStrictStripe, referenceWorkerStripe } from './references.js';

// Synthetic values only. The expected digest was computed independently with openssl:
//   printf '1700000000.<payload>' | openssl dgst -sha256 -hmac <secret>
const SECRET = 'whsec_synthetic_secret_for_tests_only';
const OTHER = 'whsec_synthetic_other_secret_for_tests';
const PAYLOAD = '{"id":"evt_test_1","object":"event"}';
const T = 1700000000;
const NOW = T * 1000;
const DIGEST = '37e39dcc7d662f6172dcb54bf74070ed2ef7f14c427f0538a4dbc7abd60628dd';

describe('Stripe signature scheme', () => {
  it('signs t=<unix>,v1=<hmac of "t.payload"> exactly as documented', async () => {
    expect(await signStripeHeader(SECRET, PAYLOAD, T)).toBe(`t=${T},v1=${DIGEST}`);
  });

  it('verifies the documented header, with extra schemes and a second v1 ignored or tried', async () => {
    const v0 = `v0=${'00'.repeat(32)}`;
    for (const header of [`t=${T},v1=${DIGEST}`, `t=${T},v1=${DIGEST},${v0}`, `${v0},v1=${'ab'.repeat(32)},v1=${DIGEST},t=${T}`, ` t=${T} , v1=${DIGEST} `]) {
      expect(await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW }), header).toEqual({ ok: true, timestamp: T, secretIndex: 0 });
    }
  });

  it('applies the five-minute tolerance both ways by default', async () => {
    const header = `t=${T},v1=${DIGEST}`;
    expect((await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW + 300_000 })).ok).toBe(true);
    expect((await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW - 300_000 })).ok).toBe(true);
    expect(await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW + 300_001 })).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
    expect(await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW - 300_001 })).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
    expect((await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW + 3_000_000, toleranceSeconds: 3600 })).ok).toBe(true);
    expect((await verifyStripeSignature(PAYLOAD, header, SECRET, { now: new Date(NOW) })).ok).toBe(true);
  });

  it('refuses a changed payload, wrong secret and a signature moved to another time', async () => {
    const header = `t=${T},v1=${DIGEST}`;
    expect(await verifyStripeSignature(`${PAYLOAD} `, header, SECRET, { now: NOW })).toEqual({ ok: false, reason: 'no_matching_signature' });
    expect(await verifyStripeSignature(PAYLOAD, header, OTHER, { now: NOW })).toEqual({ ok: false, reason: 'no_matching_signature' });
    expect(await verifyStripeSignature(PAYLOAD, `t=${T + 1},v1=${DIGEST}`, SECRET, { now: NOW })).toEqual({ ok: false, reason: 'no_matching_signature' });
  });

  it('classifies missing and malformed headers', async () => {
    for (const header of [undefined, null, '', '  ']) {
      expect(await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW })).toEqual({ ok: false, reason: 'missing_header' });
    }
    const bad = [
      `v1=${DIGEST}`, // no t
      `t=${T}`, // no v1
      `t=${T},v1=zz`, // v1 not hex
      `t=${T},t=${T},v1=${DIGEST}`, // repeated t
      `t=abc,v1=${DIGEST}`,
      `t=01,v1=${DIGEST}`,
      `t=-1,v1=${DIGEST}`,
      'x'.repeat(8193),
      `t=${T},${Array.from({ length: 33 }, () => `v1=${DIGEST}`).join(',')}`,
    ];
    for (const header of bad) expect(await verifyStripeSignature(PAYLOAD, header, SECRET, { now: NOW }), header.slice(0, 40)).toEqual({ ok: false, reason: 'malformed_header' });
  });

  it('accepts several endpoint secrets and reports which matched', async () => {
    const header = await signStripeHeader(OTHER, PAYLOAD, T);
    expect(await verifyStripeSignature(PAYLOAD, header, [SECRET, OTHER], { now: NOW })).toEqual({ ok: true, timestamp: T, secretIndex: 1 });
    expect(await verifyStripeSignature(PAYLOAD, header, [SECRET], { now: NOW })).toMatchObject({ ok: false });
  });

  it('takes the raw body as bytes', async () => {
    const bytes = new TextEncoder().encode(PAYLOAD);
    expect((await verifyStripeSignature(bytes, `t=${T},v1=${DIGEST}`, SECRET, { now: NOW })).ok).toBe(true);
  });

  it('shares its HMAC with signWebhook', async () => {
    expect(await signWebhook(SECRET, T, PAYLOAD)).toBe(DIGEST);
  });
});

describe('beside the verifiers it replaces', () => {
  type Case = { name: string; header: (valid: string, other: string) => string; now?: number };
  const cases: Case[] = [
    { name: 'valid', header: (v) => `t=${T},v1=${v}` },
    { name: 'valid for the second secret', header: (_v, o) => `t=${T},v1=${o}` },
    { name: 'v0 beside v1', header: (v) => `t=${T},v0=${'00'.repeat(32)},v1=${v}` },
    { name: 'two v1, second valid', header: (v) => `t=${T},v1=${'cd'.repeat(32)},v1=${v}` },
    { name: 'wrong signature', header: () => `t=${T},v1=${'cd'.repeat(32)}` },
    { name: 'no v1', header: () => `t=${T}` },
    { name: 'no t', header: (v) => `v1=${v}` },
    { name: 'at the tolerance edge', header: (v) => `t=${T},v1=${v}`, now: NOW + 300_000 },
    { name: 'a second past the tolerance', header: (v) => `t=${T},v1=${v}`, now: NOW + 301_000 },
    { name: 'from the future', header: (v) => `t=${T},v1=${v}`, now: NOW - 301_000 },
    { name: 'empty header', header: () => '' },
    { name: 'garbage', header: () => 'not-a-header' },
  ];

  it.each(cases)('agrees with both on $name', async ({ header, now }) => {
    const at = now ?? NOW;
    const valid = await signWebhook(SECRET, T, PAYLOAD);
    const other = await signWebhook(OTHER, T, PAYLOAD);
    const h = header(valid, other);
    const mine = await verifyStripeSignature(PAYLOAD, h, [SECRET, OTHER], { now: at });
    const lenient = await referenceWorkerStripe([SECRET, OTHER], PAYLOAD, h, at);
    expect(mine.ok).toBe(lenient.verifiedBy !== null);
    if (mine.ok) expect([SECRET, OTHER][mine.secretIndex]).toBe(lenient.verifiedBy);
    const strict = await referenceStrictStripe(SECRET, new TextEncoder().encode(PAYLOAD), h, Math.floor(at / 1000));
    const single = await verifyStripeSignature(PAYLOAD, h, SECRET, { now: at });
    expect(single.ok).toBe(strict);
  });

  it('differs only where the two originals disagree with each other and with Stripe\'s documented behavior', async () => {
    const valid = await signWebhook(SECRET, T, PAYLOAD);
    // A malformed v1 beside a valid one: the strict copy refuses the whole header; Stripe's libraries and the lenient copy accept it.
    const mixed = `t=${T},v1=not-hex,v1=${valid}`;
    expect(await referenceStrictStripe(SECRET, new TextEncoder().encode(PAYLOAD), mixed, T)).toBe(false);
    expect((await referenceWorkerStripe([SECRET], PAYLOAD, mixed, NOW)).verifiedBy).toBe(SECRET);
    expect((await verifyStripeSignature(PAYLOAD, mixed, SECRET, { now: NOW })).ok).toBe(true);
    // A repeated t: the lenient copy lets the last one win; the strict copy and the package refuse.
    const twice = `t=${T - 5000},t=${T},v1=${valid}`;
    expect((await referenceWorkerStripe([SECRET], PAYLOAD, twice, NOW)).verifiedBy).toBe(SECRET);
    expect(await referenceStrictStripe(SECRET, new TextEncoder().encode(PAYLOAD), twice, T)).toBe(false);
    expect((await verifyStripeSignature(PAYLOAD, twice, SECRET, { now: NOW })).ok).toBe(false);
  });
});
