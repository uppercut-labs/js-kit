import { describe, expect, it } from 'vitest';
import { createSlackWebhook } from '../src/index.js';
import { limited, recordedSleep, scriptedFetch, SLACK_URL } from './helpers.js';

const fine = () => new Response('ok', { status: 200 });

describe('createSlackWebhook', () => {
  it('posts text as JSON', async () => {
    const { fetcher, calls } = scriptedFetch([fine()]);
    expect(await createSlackWebhook(SLACK_URL, { fetcher }).send('hello')).toEqual({ kind: 'sent', status: 200, attempts: 1 });
    expect(calls[0]!.input).toBe(SLACK_URL);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ text: 'hello' });
  });

  it('passes blocks and attachments through and cuts long text', async () => {
    const { fetcher, calls } = scriptedFetch([fine(), fine()]);
    const hook = createSlackWebhook(SLACK_URL, { fetcher, maxTextLength: 10 });
    await hook.send({ text: 'x'.repeat(50), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*hi*' } }] });
    await hook.send({ blocks: [{ type: 'divider' }] });
    const first = JSON.parse(String(calls[0]!.init.body));
    expect(first.text).toBe(`${'x'.repeat(9)}…`);
    expect(first.blocks).toHaveLength(1);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ blocks: [{ type: 'divider' }] });
  });

  it('retries a 429 using the Retry-After header', async () => {
    const { fetcher, calls } = scriptedFetch([new Response('rate_limited', { status: 429, headers: { 'Retry-After': '30' } }), fine()]);
    const { sleep, waits } = recordedSleep();
    const result = await createSlackWebhook(SLACK_URL, { fetcher, sleep, random: () => 0 }).send('x');
    expect(result).toEqual({ kind: 'sent', status: 200, attempts: 2 });
    expect(waits).toEqual([30_000]);
    expect(calls).toHaveLength(2);
  });

  it('reports Slack error codes and 429s that do not clear', async () => {
    const bad = scriptedFetch([new Response('no_service', { status: 404 })]);
    expect(await createSlackWebhook(SLACK_URL, { fetcher: bad.fetcher }).send('x')).toEqual({ kind: 'failed', status: 404, error: 'slack 404: no_service', attempts: 1 });
    const html = scriptedFetch([new Response('<html>nope</html>', { status: 500 })]);
    expect(await createSlackWebhook(SLACK_URL, { fetcher: html.fetcher }).send('x')).toEqual({ kind: 'failed', status: 500, error: 'slack 500', attempts: 1 });
    const slow = scriptedFetch([limited(null, { 'Retry-After': '2' })]);
    const { sleep } = recordedSleep();
    expect(await createSlackWebhook(SLACK_URL, { fetcher: slow.fetcher, sleep, random: () => 0, maxRetries: 0 }).send('x')).toMatchObject({ kind: 'failed', status: 429, retryAfterMs: 2000, attempts: 1 });
    const down = scriptedFetch([new Error('offline')]);
    expect(await createSlackWebhook(SLACK_URL, { fetcher: down.fetcher }).send('x')).toMatchObject({ kind: 'failed', status: null });
  });

  it('refuses a URL that is not a Slack webhook unless told to allow it', () => {
    expect(() => createSlackWebhook('https://example.test/hook')).toThrow(TypeError);
    expect(() => createSlackWebhook('https://discord.com/api/webhooks/1/abc')).toThrow(TypeError);
    expect(() => createSlackWebhook('http://localhost:8787/hook', { allowAnyUrl: true })).not.toThrow();
  });
});
