import { buildCsp, SecurityHeadersError } from './csp.js';
import type { CspDirectives } from './csp.js';

export interface SecurityHeadersOptions {
  /** A policy string or a directive map. Omit or `false` for none. */
  readonly csp?: string | CspDirectives | false | undefined;
  /** Default `nosniff`. `false` to omit. */
  readonly contentTypeOptions?: 'nosniff' | false | undefined;
  /** Default `no-referrer`. A string is used as given; `false` to omit. */
  readonly referrerPolicy?: string | false | undefined;
  /**
   * Default `camera=(), microphone=(), geolocation=()`. A map such as `{ camera: [], fullscreen: ['self'] }`
   * becomes `camera=(), fullscreen=(self)`. `false` to omit.
   */
  readonly permissionsPolicy?: string | Readonly<Record<string, readonly string[]>> | false | undefined;
  /** Default `DENY`. `false` to omit, for a site that relies on `frame-ancestors` alone. */
  readonly frameOptions?: 'DENY' | 'SAMEORIGIN' | false | undefined;
  /** Strict-Transport-Security. Off by default: set it only for a host that is HTTPS-only. */
  readonly hsts?: false | { readonly maxAgeSeconds: number; readonly includeSubDomains?: boolean | undefined; readonly preload?: boolean | undefined } | undefined;
  readonly crossOriginOpenerPolicy?: string | false | undefined;
  readonly crossOriginResourcePolicy?: string | false | undefined;
  /** Any other headers to set as they are. */
  readonly extra?: Readonly<Record<string, string>> | undefined;
}

const HEADER_VALUE = /^[\t\x20-\x7e]*$/;

function checked(name: string, value: string): string {
  if (!HEADER_VALUE.test(value)) throw new SecurityHeadersError('invalid_header', `Invalid value for ${name}`);
  return value;
}

function permissions(value: string | Readonly<Record<string, readonly string[]>>): string {
  if (typeof value === 'string') return value;
  return Object.entries(value)
    .map(([feature, allowlist]) => `${feature}=(${allowlist.map((origin) => (origin === 'self' || origin === '*' ? origin : JSON.stringify(origin))).join(' ')})`)
    .join(', ');
}

/** The headers as a plain object with canonical names. Throws on a value that could not be sent in a header. */
export function securityHeaders(options: SecurityHeadersOptions = {}): Record<string, string> {
  const out: Record<string, string> = {};
  const csp = options.csp === undefined || options.csp === false ? null : typeof options.csp === 'string' ? options.csp : buildCsp(options.csp);
  if (csp) out['Content-Security-Policy'] = checked('Content-Security-Policy', csp);
  if (options.contentTypeOptions !== false) out['X-Content-Type-Options'] = 'nosniff';
  if (options.referrerPolicy !== false) out['Referrer-Policy'] = checked('Referrer-Policy', options.referrerPolicy ?? 'no-referrer');
  if (options.permissionsPolicy !== false) {
    out['Permissions-Policy'] = checked('Permissions-Policy', permissions(options.permissionsPolicy ?? 'camera=(), microphone=(), geolocation=()'));
  }
  if (options.frameOptions !== false) out['X-Frame-Options'] = options.frameOptions ?? 'DENY';
  if (options.hsts) {
    const { maxAgeSeconds, includeSubDomains, preload } = options.hsts;
    if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new SecurityHeadersError('invalid_header', 'hsts.maxAgeSeconds must be a non-negative integer');
    out['Strict-Transport-Security'] = `max-age=${maxAgeSeconds}${includeSubDomains ? '; includeSubDomains' : ''}${preload ? '; preload' : ''}`;
  }
  if (options.crossOriginOpenerPolicy) out['Cross-Origin-Opener-Policy'] = checked('Cross-Origin-Opener-Policy', options.crossOriginOpenerPolicy);
  if (options.crossOriginResourcePolicy) out['Cross-Origin-Resource-Policy'] = checked('Cross-Origin-Resource-Policy', options.crossOriginResourcePolicy);
  for (const [name, value] of Object.entries(options.extra ?? {})) out[name] = checked(name, value);
  return out;
}

export interface ApplyOptions {
  /** Replace a header the response already has. Default false: a route's own header, such as its page-specific policy, wins. */
  readonly overwrite?: boolean | undefined;
}

/**
 * A copy of `response` with the security headers set. The body and status are passed through untouched.
 * Headers the response already carries are kept unless `overwrite` is true, so a route that set its own
 * Content-Security-Policy keeps it. (Responses from `fetch` have immutable headers; this copies them.)
 */
export function applySecurityHeaders(response: Response, options: SecurityHeadersOptions = {}, apply: ApplyOptions = {}): Response {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(securityHeaders(options))) {
    if (apply.overwrite || !headers.has(name)) headers.set(name, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
