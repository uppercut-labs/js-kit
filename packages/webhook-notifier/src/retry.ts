export type Sleep = (milliseconds: number) => Promise<void>;

export interface RateLimitOptions {
  /** Defaults to the global `fetch`. */
  readonly fetcher?: typeof fetch;
  /** Defaults to a `setTimeout` promise. */
  readonly sleep?: Sleep;
  /** Random source returning [0, 1), used for jitter. Defaults to `Math.random`. */
  readonly random?: () => number;
  /** Retries after a 429, so a request is sent at most `maxRetries + 1` times. Default 3. */
  readonly maxRetries?: number;
  /** Longest single wait taken from the server's answer, in milliseconds. Default 30 000. */
  readonly maxDelayMs?: number;
  /** Add random delay after the server's wait: up to 1 s, 2 s, 4 s ... capped at 32 s. Default true. */
  readonly jitter?: boolean;
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long a 429 asks the client to wait, in milliseconds, or 0 when it does not say.
 * Reads, in order: Discord's JSON `retry_after` (seconds, may be fractional), the `Retry-After` header
 * (seconds or an HTTP date) and `X-RateLimit-Reset-After`. A value that is not a number is skipped.
 */
export function rateLimitDelayMs(response: Response, body: unknown, now = Date.now()): number {
  const candidates: Array<number | null> = [];
  const fromBody = body !== null && typeof body === 'object' ? (body as { retry_after?: unknown }).retry_after : undefined;
  candidates.push(typeof fromBody === 'number' && Number.isFinite(fromBody) && fromBody >= 0 ? fromBody * 1000 : null);
  const header = response.headers.get('Retry-After');
  if (header !== null) {
    const seconds = Number(header.trim());
    if (header.trim() !== '' && Number.isFinite(seconds) && seconds >= 0) candidates.push(seconds * 1000);
    else {
      const date = Date.parse(header);
      candidates.push(Number.isNaN(date) ? null : Math.max(0, date - now));
    }
  }
  const reset = response.headers.get('X-RateLimit-Reset-After');
  if (reset !== null) {
    const seconds = Number(reset.trim());
    candidates.push(reset.trim() !== '' && Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null);
  }
  return candidates.find((value): value is number => value !== null) ?? 0;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.clone().json();
  } catch {
    return null;
  }
}

/**
 * `fetch` that waits and retries when the server answers 429. Other statuses, including errors, are returned
 * as they are; a network failure throws as `fetch` does. The last 429 is returned once the retries are used up.
 * The body must be re-sendable (a string or bytes, not a stream).
 */
export async function fetchWithRateLimit(input: string | URL, init: RequestInit = {}, options: RateLimitOptions = {}): Promise<Response> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxRetries = options.maxRetries ?? 3;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  if (!Number.isSafeInteger(maxRetries) || maxRetries < 0) throw new RangeError('maxRetries must be a non-negative integer');
  let attempt = 0;
  for (;;) {
    const response = await fetcher(input, init);
    if (response.status !== 429 || attempt >= maxRetries) return response;
    const server = Math.min(rateLimitDelayMs(response, await readJson(response)), maxDelayMs);
    const jitter = options.jitter === false ? 0 : Math.floor(random() * Math.min(32_000, 1_000 * 2 ** attempt));
    await sleep(server + jitter);
    attempt += 1;
  }
}
