import { describe, expect, it } from 'vitest';
import { createDiscordWebhook, truncateText } from '../src/index.js';
import { DISCORD_URL, limited, recordedSleep, scriptedFetch } from './helpers.js';
import { referenceDiscordSender } from './references.js';

const noContent = () => new Response(null, { status: 204 });

describe('createDiscordWebhook', () => {
  it('posts content as JSON and pings nobody by default', async () => {
    const { fetcher, calls } = scriptedFetch([noContent()]);
    const result = await createDiscordWebhook(DISCORD_URL, { fetcher }).send('hello @everyone <@123>');
    expect(result).toEqual({ kind: 'sent', status: 204, attempts: 1 });
    expect(calls[0]!.input).toBe(DISCORD_URL);
    expect(calls[0]!.init.method).toBe('POST');
    expect(new Headers(calls[0]!.init.headers).get('content-type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: 'hello @everyone <@123>', allowed_mentions: { parse: [] } });
  });

  it('passes embeds and other fields through and lets a message set its own mentions', async () => {
    const { fetcher, calls } = scriptedFetch([noContent(), noContent()]);
    const hook = createDiscordWebhook(DISCORD_URL, { fetcher });
    await hook.send({ username: 'Notifier', embeds: [{ title: 'T', fields: [{ name: 'a', value: 'b' }] }] });
    await hook.send({ content: '<@42>', allowed_mentions: { users: ['42'] } });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ username: 'Notifier', embeds: [{ title: 'T', fields: [{ name: 'a', value: 'b' }] }], allowed_mentions: { parse: [] } });
    expect(JSON.parse(String(calls[1]!.init.body)).allowed_mentions).toEqual({ users: ['42'] });
  });

  it('can leave allowed_mentions to Discord', async () => {
    const { fetcher, calls } = scriptedFetch([noContent()]);
    await createDiscordWebhook(DISCORD_URL, { fetcher, allowedMentions: null }).send('x');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ content: 'x' });
  });

  it('cuts content to the limit by characters, not UTF-16 units', async () => {
    const { fetcher, calls } = scriptedFetch([noContent(), noContent()]);
    const hook = createDiscordWebhook(DISCORD_URL, { fetcher });
    await hook.send('a'.repeat(2500));
    await hook.send('\u{1F600}'.repeat(2000)); // 2000 characters, 4000 UTF-16 units: fits
    const first = JSON.parse(String(calls[0]!.init.body)).content as string;
    expect([...first]).toHaveLength(2000);
    expect(first.endsWith('…')).toBe(true);
    expect([...(JSON.parse(String(calls[1]!.init.body)).content as string)]).toHaveLength(2000);
    expect(truncateText('short', 10)).toBe('short');
    expect(truncateText('abcdef', 4)).toBe('abc…');
  });

  it('waits out a 429 and then sends', async () => {
    const { fetcher, calls } = scriptedFetch([limited({ message: 'You are being rate limited.', retry_after: 0.75, global: false }), noContent()]);
    const { sleep, waits } = recordedSleep();
    const result = await createDiscordWebhook(DISCORD_URL, { fetcher, sleep, random: () => 0 }).send('x');
    expect(result).toEqual({ kind: 'sent', status: 204, attempts: 2 });
    expect(waits).toEqual([750]);
    expect(calls).toHaveLength(2);
  });

  it('reports a 429 that never clears, with how long the server asked to wait', async () => {
    const { fetcher } = scriptedFetch([limited({ message: 'You are being rate limited.', retry_after: 4 })]);
    const { sleep } = recordedSleep();
    const result = await createDiscordWebhook(DISCORD_URL, { fetcher, sleep, random: () => 0, maxRetries: 1 }).send('x');
    expect(result).toEqual({ kind: 'failed', status: 429, error: 'discord 429: You are being rate limited.', attempts: 2, retryAfterMs: 4000 });
  });

  it('reports other failures without throwing and without the URL', async () => {
    const bad = scriptedFetch([new Response(JSON.stringify({ message: 'Unknown Webhook', code: 10015 }), { status: 404 })]);
    const unknown = await createDiscordWebhook(DISCORD_URL, { fetcher: bad.fetcher }).send('x');
    expect(unknown).toEqual({ kind: 'failed', status: 404, error: 'discord 404: Unknown Webhook', attempts: 1 });
    const html = scriptedFetch([new Response('<html>Bad gateway</html>', { status: 502 })]);
    expect(await createDiscordWebhook(DISCORD_URL, { fetcher: html.fetcher }).send('x')).toMatchObject({ kind: 'failed', status: 502, attempts: 1 });
    const down = scriptedFetch([new TypeError(`fetch failed for ${DISCORD_URL}`)]);
    const network = await createDiscordWebhook(DISCORD_URL, { fetcher: down.fetcher }).send('x');
    expect(network).toEqual({ kind: 'failed', status: null, error: 'request failed before a response arrived', attempts: 1 });
    for (const result of [unknown, network]) expect(JSON.stringify(result)).not.toContain('synthetic-token');
  });

  it('refuses a URL that is not a Discord webhook unless told to allow it', () => {
    expect(() => createDiscordWebhook('https://example.test/hook')).toThrow(TypeError);
    expect(() => createDiscordWebhook('https://hooks.slack.com/services/T/B/c')).toThrow(TypeError);
    expect(() => createDiscordWebhook('http://localhost:8787/hook', { allowAnyUrl: true })).not.toThrow();
  });
});

describe('beside the sender it replaces', () => {
  it('answers sent or failed the same way for ok, non-ok and thrown responses', async () => {
    const answers: Array<Response | Error> = [new Response(null, { status: 204 }), new Response('{}', { status: 200 }), new Response('{}', { status: 400 }), new Response('{}', { status: 500 }), new Error('boom')];
    for (const answer of answers) {
      const a = scriptedFetch([answer]);
      const b = scriptedFetch([answer]);
      const mine = await createDiscordWebhook(DISCORD_URL, { fetcher: a.fetcher }).send('same text');
      const theirs = await referenceDiscordSender(DISCORD_URL, b.fetcher).send('same text');
      expect(mine.kind).toBe(theirs.kind);
      expect(JSON.parse(String(a.calls[0]!.init.body)).content).toBe(JSON.parse(String(b.calls[0]!.init.body)).content);
    }
  });

  it('differs on a 429: it waits and retries where the old sender failed at once', async () => {
    const script = [limited({ retry_after: 1 }), new Response(null, { status: 204 })];
    const old = await referenceDiscordSender(DISCORD_URL, scriptedFetch(script).fetcher).send('x');
    const { sleep } = recordedSleep();
    const now = await createDiscordWebhook(DISCORD_URL, { fetcher: scriptedFetch(script).fetcher, sleep, random: () => 0 }).send('x');
    expect(old.kind).toBe('failed');
    expect(now.kind).toBe('sent');
  });
});
