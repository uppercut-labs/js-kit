export type CspSources = string | readonly string[];
/** A directive map. `true` writes the bare directive (`upgrade-insecure-requests`); `false`, `null` and `undefined` leave it out. */
export type CspDirectives = Readonly<Record<string, CspSources | true | false | null | undefined>>;

export class SecurityHeadersError extends Error {
  readonly code: 'invalid_directive' | 'invalid_source' | 'invalid_origin' | 'invalid_header' | 'missing_header';
  constructor(code: SecurityHeadersError['code'], message: string) {
    super(message);
    this.name = 'SecurityHeadersError';
    this.code = code;
  }
}

const DIRECTIVE = /^[a-z][a-z0-9-]*$/;
// A source is one token: no whitespace, no `;` (ends a directive), no `,` (separates policies), no control characters.
const BAD_TOKEN = /[\s;,\u0000-\u001f\u007f]/;

function tokens(value: CspSources | true | false | null | undefined): string[] | null {
  if (value === undefined || value === null || value === false) return null;
  if (value === true) return [];
  const list = typeof value === 'string' ? value.split(/\s+/) : [...value];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== 'string') throw new SecurityHeadersError('invalid_source', 'A CSP source must be a string');
    if (raw === '') continue;
    if (BAD_TOKEN.test(raw)) throw new SecurityHeadersError('invalid_source', `Invalid CSP source ${JSON.stringify(raw)}`);
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * `{ 'default-src': "'self'", 'img-src': ["'self'", 'data:'] }` becomes `default-src 'self'; img-src 'self' data:`.
 * Directives keep the order you wrote them. A string source is split on spaces. A source containing `;`, `,`,
 * whitespace or a control character throws, so a configured value cannot add a directive or a second policy.
 */
export function buildCsp(directives: CspDirectives): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(directives)) {
    const list = tokens(value);
    if (list === null) continue;
    if (!DIRECTIVE.test(name)) throw new SecurityHeadersError('invalid_directive', `Invalid CSP directive name ${JSON.stringify(name)}`);
    parts.push(list.length === 0 ? name : `${name} ${list.join(' ')}`);
  }
  return parts.join('; ');
}

/** Read a policy string back into a directive map. The first occurrence of a repeated directive wins, as browsers do. */
export function parseCsp(policy: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name || !DIRECTIVE.test(name.toLowerCase()) || name.toLowerCase() in out) continue;
    out[name.toLowerCase()] = sources.filter(Boolean);
  }
  return out;
}

/**
 * Add sources to a policy. Each directive in `additions` is appended to the same directive in `base`
 * (duplicates dropped) or added when `base` has none. A `'none'` in the base is dropped when sources are
 * added to that directive, because `'none'` beside other sources is invalid.
 * Use it for a per-route policy: one base policy, then `extendCsp(base, { 'img-src': 'https://img.example.test' })`.
 */
export function extendCsp(base: CspDirectives | string, additions: CspDirectives): Record<string, string[]> {
  const merged: Record<string, string[]> = {};
  const source = typeof base === 'string' ? parseCsp(base) : base;
  for (const [name, value] of Object.entries(source)) {
    const list = tokens(value);
    if (list !== null) merged[name] = list;
  }
  for (const [name, value] of Object.entries(additions)) {
    const list = tokens(value);
    if (list === null) continue;
    if (!DIRECTIVE.test(name)) throw new SecurityHeadersError('invalid_directive', `Invalid CSP directive name ${JSON.stringify(name)}`);
    const current = merged[name] ?? [];
    const withoutNone = list.length > 0 ? current.filter((token) => token !== "'none'") : current;
    for (const token of list) if (!withoutNone.includes(token)) withoutNone.push(token);
    merged[name] = withoutNone;
  }
  return merged;
}

/**
 * The origin of a URL for use as a CSP source: `https://api.example.test/v1?x=1` becomes `https://api.example.test`.
 * A blank value gives `''`, so an unset setting adds nothing. Anything that is not an http(s) URL throws.
 */
export function cspOrigin(value: string | null | undefined): string {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed === '') return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new SecurityHeadersError('invalid_origin', 'Expected an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new SecurityHeadersError('invalid_origin', 'Expected an http or https URL');
  return url.origin;
}

/** Make a URL safe to use as one CSP source when it may contain `;`, `,` or spaces, by percent-encoding them. */
export function escapeCspSource(value: string): string {
  return value.replace(/[;,\s]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);
}
