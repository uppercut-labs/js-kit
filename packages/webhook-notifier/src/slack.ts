import { postJson, truncateText } from './send.js';
import type { SendResult } from './send.js';
import type { RateLimitOptions } from './retry.js';
import { webhookKind } from './url.js';

export interface SlackMessage {
  readonly text?: string | undefined;
  readonly blocks?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly attachments?: ReadonlyArray<Record<string, unknown>> | undefined;
  readonly [key: string]: unknown;
}

export interface SlackWebhookOptions extends RateLimitOptions {
  /** Longest `text`, in characters. Default 40 000, Slack's limit. */
  readonly maxTextLength?: number | undefined;
  /** Accept a URL that is not on `hooks.slack.com`, for a test server or a proxy. */
  readonly allowAnyUrl?: boolean | undefined;
}

export interface SlackWebhook {
  send(message: string | SlackMessage): Promise<SendResult>;
}

export function createSlackWebhook(url: string, options: SlackWebhookOptions = {}): SlackWebhook {
  if (!options.allowAnyUrl && webhookKind(url) !== 'slack') throw new TypeError('Not a Slack webhook URL');
  const max = options.maxTextLength ?? 40_000;
  return {
    async send(message) {
      const body: Record<string, unknown> = typeof message === 'string' ? { text: message } : { ...message };
      if (typeof body.text === 'string') body.text = truncateText(body.text, max);
      // Slack answers errors with a short plain-text code such as `invalid_payload` or `no_service`.
      return postJson(url, body, options, (status, _json, text) => {
        const code = /^[a-z0-9_ -]{1,60}$/i.test(text.trim()) ? text.trim() : '';
        return code ? `slack ${status}: ${code}` : `slack ${status}`;
      });
    },
  };
}
