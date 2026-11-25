/**
 * Reference copy of the 429 loop this package replaces in a bot client: server wait from the JSON
 * `retry_after`, then `Retry-After`, then `X-RateLimit-Reset-After`, plus jitter, three retries, no cap.
 */
export async function referenceRequestWithRateLimit(
  fetcher: typeof fetch,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
  input: string,
  init: RequestInit,
): Promise<Response> {
  const MAX = 3;
  for (let attempt = 0; attempt <= MAX; attempt += 1) {
    const response = await fetcher(input, init);
    if (response.status !== 429 || attempt === MAX) return response;
    const value = await response.clone().json().catch(() => null);
    const payload = typeof value === 'object' && value !== null && typeof (value as { retry_after?: unknown }).retry_after === 'number' ? (value as { retry_after: number }) : {};
    const retryAfterHeader = response.headers.get('Retry-After');
    const resetAfterHeader = response.headers.get('X-RateLimit-Reset-After');
    const seconds = (payload as { retry_after?: number }).retry_after
      ?? (retryAfterHeader === null ? undefined : Number(retryAfterHeader))
      ?? (resetAfterHeader === null ? undefined : Number(resetAfterHeader));
    const serverDelay = Number.isFinite(seconds) ? Math.max(0, (seconds ?? 0) * 1000) : 0;
    const jitter = Math.floor(random() * Math.min(32_000, 1_000 * 2 ** attempt));
    await sleep(serverDelay + jitter);
  }
  throw new Error('unreachable');
}

/** Reference copy of a minimal Discord webhook sender: one POST, any non-2xx or exception is a failure. */
export function referenceDiscordSender(webhookUrl: string, fetchImpl: typeof fetch) {
  return {
    async send(body: string): Promise<{ readonly kind: 'sent' } | { readonly kind: 'failed' }> {
      let response: Response;
      try {
        response = await fetchImpl(webhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content: body }) });
      } catch {
        return { kind: 'failed' };
      }
      if (!response.ok) return { kind: 'failed' };
      return { kind: 'sent' };
    },
  };
}
