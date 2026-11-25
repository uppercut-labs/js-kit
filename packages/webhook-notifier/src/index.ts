/**
 * Post to Discord and Slack webhooks with 429 handling. Uses only `fetch`: Cloudflare Workers, Deno, Bun,
 * browsers and Node 18+.
 */
export { fetchWithRateLimit, rateLimitDelayMs } from './retry.js';
export type { RateLimitOptions, Sleep } from './retry.js';
export { createDiscordWebhook } from './discord.js';
export type { DiscordMessage, DiscordWebhook, DiscordWebhookOptions } from './discord.js';
export { createSlackWebhook } from './slack.js';
export type { SlackMessage, SlackWebhook, SlackWebhookOptions } from './slack.js';
export { truncateText } from './send.js';
export type { SendResult } from './send.js';
export { redactWebhookUrl, webhookKind } from './url.js';
export type { WebhookKind } from './url.js';
