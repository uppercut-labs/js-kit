import { fetchWithRateLimit, rateLimitDelayMs } from './retry.js';
import type { RateLimitOptions } from './retry.js';

export type SendResult =
  | { readonly kind: 'sent'; readonly status: number; /** Requests made, including retries. */ readonly attempts: number }
  | {
      readonly kind: 'failed';
      readonly status: number | null;
      /** A short reason that never contains the webhook URL. */
      readonly error: string;
      readonly attempts: number;
      /** Set when the last answer was a 429: how long the server asked to wait. */
      readonly retryAfterMs?: number;
    };

/** Count Unicode characters, not UTF-16 units, and cut with an ellipsis. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  const chars = [...text];
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

/** POST a JSON payload to a webhook, retrying on 429. Never throws for HTTP or network failure. */
export async function postJson(url: string, payload: unknown, options: RateLimitOptions, describeError: (status: number, body: unknown, text: string) => string): Promise<SendResult> {
  let attempts = 0;
  const counting: typeof fetch = async (input, init) => {
    attempts += 1;
    return (options.fetcher ?? fetch)(input, init);
  };
  let response: Response;
  try {
    response = await fetchWithRateLimit(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }, { ...options, fetcher: counting });
  } catch {
    return { kind: 'failed', status: null, error: 'request failed before a response arrived', attempts };
  }
  if (response.ok) return { kind: 'sent', status: response.status, attempts };
  let text = '';
  let body: unknown = null;
  try {
    text = (await response.text()).slice(0, 500);
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  const result = { kind: 'failed' as const, status: response.status, error: describeError(response.status, body, text), attempts };
  return response.status === 429 ? { ...result, retryAfterMs: rateLimitDelayMs(response, body) } : result;
}
