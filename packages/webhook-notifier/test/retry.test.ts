import { describe, expect, it } from 'vitest';
import { fetchWithRateLimit, rateLimitDelayMs } from '../src/index.js';
import { limited, recordedSleep, scriptedFetch } from './helpers.js';
import { referenceRequestWithRateLimit } from './references.js';

const ok = () => new Response('{}', { status: 200 });

describe('rateLimitDelayMs', () => {
  const res = (headers: Record<string, string> = {}) => new Response(null, { status: 429, headers });

  it('prefers the JSON body, then Retry-After, then X-RateLimit-Reset-After', () => {
    expect(rateLimitDelayMs(res({ 'Retry-After': '9', 'X-RateLimit-Reset-After': '7' }), { retry_after: 1.5 })).toBe(1500);
    expect(rateLimitDelayMs(res({ 'Retry-After': '9', 'X-RateLimit-Reset-After': '7' }), null)).toBe(9000);
    expect(rateLimitDelayMs(res({ 'X-RateLimit-Reset-After': '0.25' }), {})).toBe(250);
    expect(rateLimitDelayMs(res(), {})).toBe(0);
  });

  it('reads an HTTP date in Retry-After and skips values it cannot read', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    expect(rateLimitDelayMs(res({ 'Retry-After': 'Thu, 01 Jan 2026 00:00:05 GMT' }), null, now)).toBe(5000);
    expect(rateLimitDelayMs(res({ 'Retry-After': 'Wed, 31 Dec 2025 23:00:00 GMT' }), null, now)).toBe(0);
    // An unreadable Retry-After falls through to the next source instead of ending the search.
    expect(rateLimitDelayMs(res({ 'Retry-After': 'soon', 'X-RateLimit-Reset-After': '2' }), null)).toBe(2000);
    expect(rateLimitDelayMs(res({ 'Retry-After': '' }), { retry_after: 'x' })).toBe(0);
    expect(rateLimitDelayMs(res({ 'Retry-After': '-3' }), { retry_after: -1 })).toBe(0);
  });
});

describe('fetchWithRateLimit', () => {
  it('returns anything but a 429 at once, errors included', async () => {
    for (const status of [200, 204, 400, 404, 500]) {
      const { fetcher, calls } = scriptedFetch([new Response(null, { status })]);
      const { sleep, waits } = recordedSleep();
      expect((await fetchWithRateLimit('https://example.test/x', {}, { fetcher, sleep })).status).toBe(status);
      expect(calls).toHaveLength(1);
      expect(waits).toEqual([]);
    }
  });

  it('waits what the server says plus jitter, then retries with the same request', async () => {
    const { fetcher, calls } = scriptedFetch([limited({ retry_after: 2 }), limited(null, { 'Retry-After': '1' }), ok()]);
    const { sleep, waits } = recordedSleep();
    const init = { method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json' } };
    const response = await fetchWithRateLimit('https://example.test/x', init, { fetcher, sleep, random: () => 0.5 });
    expect(response.status).toBe(200);
    expect(waits).toEqual([2000 + 500, 1000 + 1000]); // jitter: floor(0.5 * 1000), floor(0.5 * 2000)
    expect(calls.map((c) => c.init.body)).toEqual(['{"a":1}', '{"a":1}', '{"a":1}']);
    expect(calls.every((c) => c.input === 'https://example.test/x')).toBe(true);
  });

  it('gives up after maxRetries and returns the last 429', async () => {
    const { fetcher, calls } = scriptedFetch([limited({ retry_after: 0.1 })]);
    const { sleep, waits } = recordedSleep();
    const response = await fetchWithRateLimit('https://example.test/x', {}, { fetcher, sleep, random: () => 0, maxRetries: 2 });
    expect(response.status).toBe(429);
    expect(calls).toHaveLength(3);
    expect(waits).toEqual([100, 100]);
    const none = scriptedFetch([limited({ retry_after: 1 })]);
    expect((await fetchWithRateLimit('https://example.test/x', {}, { fetcher: none.fetcher, sleep, maxRetries: 0 })).status).toBe(429);
    expect(none.calls).toHaveLength(1);
  });

  it('caps one server wait and can drop the jitter', async () => {
    const { fetcher } = scriptedFetch([limited({ retry_after: 3600 }), ok()]);
    const { sleep, waits } = recordedSleep();
    await fetchWithRateLimit('https://example.test/x', {}, { fetcher, sleep, maxDelayMs: 5000, jitter: false });
    expect(waits).toEqual([5000]);
  });

  it('lets a network failure throw as fetch does, and rejects a bad maxRetries', async () => {
    const { fetcher } = scriptedFetch([new TypeError('network down')]);
    await expect(fetchWithRateLimit('https://example.test/x', {}, { fetcher })).rejects.toThrow('network down');
    await expect(fetchWithRateLimit('https://example.test/x', {}, { fetcher, maxRetries: -1 })).rejects.toBeInstanceOf(RangeError);
  });

  it('keeps the same waits as the loop it replaces on the same answers', async () => {
    const scripts: Array<Array<Response | Error>> = [
      [limited({ retry_after: 1.25 }), ok()],
      [limited(null, { 'Retry-After': '3' }), limited(null, { 'X-RateLimit-Reset-After': '0.5' }), ok()],
      [limited({}), limited({}), limited({}), limited({}), limited({})],
      [limited({ retry_after: 2 }), new Response(null, { status: 403 })],
      [limited({ retry_after: 1, global: true }), limited({ retry_after: 0 }), ok()],
    ];
    for (const script of scripts) {
      for (const r of [0, 0.37, 0.99]) {
        const a = scriptedFetch(script);
        const b = scriptedFetch(script);
        const sleepsA = recordedSleep();
        const sleepsB = recordedSleep();
        const mine = await fetchWithRateLimit('https://example.test/x', { method: 'POST' }, { fetcher: a.fetcher, sleep: sleepsA.sleep, random: () => r, maxDelayMs: Infinity });
        const theirs = await referenceRequestWithRateLimit(b.fetcher, sleepsB.sleep, () => r, 'https://example.test/x', { method: 'POST' });
        expect(mine.status).toBe(theirs.status);
        expect(sleepsA.waits).toEqual(sleepsB.waits);
        expect(a.calls).toHaveLength(b.calls.length);
      }
    }
  });
});
