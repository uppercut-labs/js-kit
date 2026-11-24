# @uppercut-labs/webhook-notifier

Post a message to a Discord or Slack webhook, and wait and retry when the service answers 429. It also exports the 429 loop alone, for any client that sends JSON with `fetch`, such as a Discord bot calling the REST API. No runtime dependencies; it uses only `fetch`, so it runs in Cloudflare Workers, Deno, Bun, browsers and Node 18+.

```sh
npm install @uppercut-labs/webhook-notifier
```

```ts
import { createDiscordWebhook, createSlackWebhook } from '@uppercut-labs/webhook-notifier';

const discord = createDiscordWebhook(env.DISCORD_WEBHOOK_URL);
const result = await discord.send('Deploy finished');
if (result.kind === 'failed') console.error(result.error, result.status); // never contains the URL

const slack = createSlackWebhook(env.SLACK_WEBHOOK_URL);
await slack.send({ text: 'Deploy finished', blocks: [{ type: 'divider' }] });
```

`send` never throws for an HTTP or network failure. It resolves to:

- `{ kind: 'sent', status, attempts }`
- `{ kind: 'failed', status, error, attempts, retryAfterMs? }`: `status` is `null` when no response arrived, and `retryAfterMs` is set when the last answer was a 429.

`attempts` counts requests, including retries. `error` is a short reason (`discord 404: Unknown Webhook`, `slack 404: no_service`) and never holds the webhook URL.

## Discord

`createDiscordWebhook(url, options?)`; `send(text | message)` where a message is the webhook body (`content`, `username`, `avatar_url`, `embeds`, ...).

- `content` over `maxContentLength` (default 2000 characters, Discord's limit) is cut with an ellipsis. Characters are counted as Unicode characters, not UTF-16 units.
- A message that sets no `allowed_mentions` is sent with `{ parse: [] }`, so `@everyone`, `@here` and `<@id>` in text you did not write ping nobody. Set `allowedMentions` to change the default, or `null` to leave it to Discord.

## Slack

`createSlackWebhook(url, options?)`; `send(text | message)` where a message is the body of an incoming webhook (`text`, `blocks`, `attachments`, ...). `text` over `maxTextLength` (default 40 000) is cut with an ellipsis.

## 429 handling

On a 429 the request waits and is sent again, up to `maxRetries` times (default 3). The wait is what the server asks for, read from Discord's JSON `retry_after` (seconds, may be fractional), then the `Retry-After` header (seconds or an HTTP date), then `X-RateLimit-Reset-After`; a value that cannot be read is skipped. A single server wait is capped at `maxDelayMs` (default 30 000). Jitter of up to 1 s, 2 s, 4 s and so on (to 32 s) is added unless `jitter: false`. Other statuses are never retried.

| Option | Default | Meaning |
| --- | --- | --- |
| `fetcher` | global `fetch` | Your own fetch, for tests or a proxy |
| `sleep` | `setTimeout` | Replace it in tests |
| `random` | `Math.random` | Source for jitter |
| `maxRetries` | `3` | Retries after a 429 |
| `maxDelayMs` | `30000` | Longest single wait taken from the server |
| `jitter` | `true` | Add random delay after the server's wait |

### The loop on its own

```ts
import { fetchWithRateLimit } from '@uppercut-labs/webhook-notifier';

const response = await fetchWithRateLimit('https://discord.com/api/v10/channels/1/messages', {
  method: 'POST',
  headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'hi' }),
});
```

`fetchWithRateLimit(input, init, options)` returns the first response that is not a 429, or the last 429 once the retries are used up. The body must be re-sendable (a string or bytes, not a stream). A network failure throws as `fetch` does. `rateLimitDelayMs(response, body)` is the wait calculation by itself.

## URL helpers

- `webhookKind(url)`: `'discord'`, `'slack'` or `null`, judged by https, host and path. A URL with credentials, a port or a look-alike host is `null`.
- `redactWebhookUrl(url)`: `https://discord.com/api/webhooks/123/[redacted]` for logs. An unknown URL becomes `[redacted webhook url]`.

`createDiscordWebhook` and `createSlackWebhook` throw a `TypeError` for a URL of the wrong kind, so a configuration mistake cannot send a message to another host. Set `allowAnyUrl` to point at a test server or a proxy.

## Tests

The suite runs scripted `fetch` answers and a recorded `sleep`. It also runs reference copies of the 429 loop and the one-shot Discord sender this package replaces, and compares their waits, call counts and sent or failed answers.

## License

MIT
