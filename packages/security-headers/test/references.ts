/**
 * Reference copies of the header and policy code this package replaces, as they behaved.
 * Origins are synthetic.
 */

/** A static site's build-time policy from an API base URL. */
export function referenceSitePolicy(apiBase: unknown): string {
  const trimmed = typeof apiBase === 'string' ? apiBase.trim() : '';
  const origin = trimmed ? new URL(trimmed).origin : '';
  const api = origin ? ` ${origin}` : '';
  return [
    "default-src 'self'",
    `connect-src 'self'${api} https://cdn.example.test`,
    `img-src 'self' data: blob:${api}`,
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' https://cdn.example.test",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ');
}

/** The build step that swaps the policy line in a `_headers` file. */
export function referenceWriteHeaders(text: string, policy: string): string {
  if (!text.includes('Content-Security-Policy:')) throw new Error('dist/_headers is missing Content-Security-Policy');
  return text.replace(/Content-Security-Policy:.*/, `Content-Security-Policy: ${policy}`);
}

/** A Worker app's policy, with an optional form target for sign-out. */
export function referenceAppPolicy(issuerLogout?: string): string {
  const formTargets = issuerLogout ? "'self' " + issuerLogout : "'self'";
  return `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; form-action ${formTargets}; base-uri 'none'; frame-ancestors 'none'`;
}

export function referenceEscape(url: string): string {
  return url.replaceAll(';', '%3B').replaceAll(',', '%2C');
}

/** A Worker's response wrapper: four headers on a copy of the response. */
export function referenceSecureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  headers.set('referrer-policy', 'no-referrer');
  headers.set('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  headers.set(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export const COVER_ORIGIN = 'https://img.example.test';
export const WIDGET_ORIGIN = 'https://player.example.test';
export const AUDIO_ORIGIN = 'https://audio.example.test:8443';
export const CHECK_ORIGIN = 'https://check.example.test:8444';

const BASE = ["default-src 'none'", "script-src 'self'", "style-src 'self'", "font-src 'self'"];
const CONNECT = "connect-src 'self'";
const TAIL = [CONNECT, "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'", "object-src 'none'"];

/** A per-route policy family built by string splicing. */
export const referenceFamily = {
  app: [...BASE, "img-src 'self'", ...TAIL].join('; '),
  media: [...BASE, `img-src 'self' ${COVER_ORIGIN}`, ...TAIL, `frame-src ${WIDGET_ORIGIN}`].join('; '),
  cover: [...BASE, `img-src 'self' ${COVER_ORIGIN}`, ...TAIL].join('; '),
  playback: [
    ...BASE,
    `img-src 'self' ${COVER_ORIGIN}`,
    ...TAIL.map((part) => (part === CONNECT ? [CONNECT, AUDIO_ORIGIN, CHECK_ORIGIN].filter(Boolean).join(' ') : part)),
    `frame-src ${WIDGET_ORIGIN}`,
    `media-src ${AUDIO_ORIGIN}`,
  ].join('; '),
};
