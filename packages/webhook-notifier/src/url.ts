export type WebhookKind = 'discord' | 'slack';

const DISCORD_HOSTS = new Set(['discord.com', 'ptb.discord.com', 'canary.discord.com', 'discordapp.com']);

/** Which service a webhook URL belongs to, judged by its host and path; `null` for anything else. */
export function webhookKind(value: string): WebhookKind | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') return null;
  if (DISCORD_HOSTS.has(url.hostname) && /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) return 'discord';
  if (url.hostname === 'hooks.slack.com' && /^\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+$/.test(url.pathname)) return 'slack';
  return null;
}

/**
 * The URL with its secret part replaced, safe for logs and error messages:
 * `https://discord.com/api/webhooks/123/[redacted]`, `https://hooks.slack.com/services/[redacted]`.
 * Anything that is not a known webhook URL comes back as `[redacted webhook url]`.
 */
export function redactWebhookUrl(value: string): string {
  const kind = webhookKind(value);
  if (kind === 'discord') return value.replace(/^(https:\/\/[^/]+\/api(?:\/v\d+)?\/webhooks\/\d+\/)[^?#]*/, '$1[redacted]').replace(/[?#].*$/, '');
  if (kind === 'slack') return value.replace(/^(https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/)[^?#]*/, '$1[redacted]').replace(/[?#].*$/, '');
  return '[redacted webhook url]';
}
