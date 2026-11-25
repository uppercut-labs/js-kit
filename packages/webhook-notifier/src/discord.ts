import { postJson, truncateText } from './send.js';
import type { SendResult } from './send.js';
import type { RateLimitOptions } from './retry.js';
import { webhookKind } from './url.js';

export interface DiscordMessage {
  readonly content?: string | undefined;
  readonly username?: string | undefined;
  readonly avatar_url?: string | undefined;
  readonly embeds?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly allowed_mentions?: Record<string, unknown> | undefined;
  readonly [key: string]: unknown;
}

export interface DiscordWebhookOptions extends RateLimitOptions {
  /** Longest `content`, in characters. Longer text is cut with an ellipsis. Default 2000, Discord's limit. */
  readonly maxContentLength?: number | undefined;
  /**
   * Sent when a message sets none. The default `{ parse: [] }` pings nobody, so `@everyone` or `<@id>` in
   * text you did not write stays plain text. Pass `null` to leave Discord's default behavior.
   */
  readonly allowedMentions?: Record<string, unknown> | null | undefined;
  /** Accept a URL that is not a Discord webhook URL, for a test server or a proxy. */
  readonly allowAnyUrl?: boolean | undefined;
}

export interface DiscordWebhook {
  send(message: string | DiscordMessage): Promise<SendResult>;
}

export function createDiscordWebhook(url: string, options: DiscordWebhookOptions = {}): DiscordWebhook {
  if (!options.allowAnyUrl && webhookKind(url) !== 'discord') throw new TypeError('Not a Discord webhook URL');
  const max = options.maxContentLength ?? 2000;
  const mentions = options.allowedMentions === undefined ? { parse: [] } : options.allowedMentions;
  return {
    async send(message) {
      const body: Record<string, unknown> = typeof message === 'string' ? { content: message } : { ...message };
      if (typeof body.content === 'string') body.content = truncateText(body.content, max);
      if (mentions !== null && body.allowed_mentions === undefined) body.allowed_mentions = mentions;
      return postJson(url, body, options, (status, json, text) => {
        const reason = json !== null && typeof json === 'object' && typeof (json as { message?: unknown }).message === 'string' ? (json as { message: string }).message : text.slice(0, 120);
        return reason ? `discord ${status}: ${reason}` : `discord ${status}`;
      });
    },
  };
}
