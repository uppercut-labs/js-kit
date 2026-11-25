/** A scripted fetch: each call takes the next response (or throws it) and records the request. */
export interface Call {
  readonly input: string;
  readonly init: RequestInit;
}

export function scriptedFetch(script: Array<Response | Error>) {
  const calls: Call[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ input: String(input), init: init ?? {} });
    const next = script[Math.min(calls.length - 1, script.length - 1)]!;
    if (next instanceof Error) throw next;
    return next.clone();
  }) as typeof fetch;
  return { fetcher, calls };
}

export function recordedSleep() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

export const limited = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(body === null ? null : JSON.stringify(body), { status: 429, headers: { 'content-type': 'application/json', ...headers } });

// Synthetic webhook URLs; the id and token are made up.
export const DISCORD_URL = 'https://discord.com/api/webhooks/123456789012345678/synthetic-token_ABC-123';
export const SLACK_URL = 'https://hooks.slack.com/services/T0SYNTH00/B0SYNTH00/synthetictoken123';
