import { SecurityHeadersError } from './csp.js';

export interface HeadersRule {
  /** A path pattern such as `/*` or `/assets/*`. */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
}

function line(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new SecurityHeadersError('invalid_header', `${what} must be one line`);
  return value;
}

/** The text of a Cloudflare Pages / Netlify `_headers` file: a path line, then its headers indented by two spaces. */
export function buildHeadersFile(rules: readonly HeadersRule[]): string {
  return `${rules
    .map((rule) => [line(rule.path, 'A path'), ...Object.entries(rule.headers).map(([name, value]) => `  ${line(name, 'A header name')}: ${line(value, 'A header value')}`)].join('\n'))
    .join('\n\n')}\n`;
}

/**
 * Replace a header's value in a `_headers` file, in every rule or only the rule for `path`.
 * Throws when the header is not there, so a build cannot quietly ship a file without it.
 * Header names are matched without regard to case.
 */
export function setHeaderInHeadersFile(text: string, name: string, value: string, options: { readonly path?: string | undefined } = {}): string {
  line(name, 'A header name');
  line(value, 'A header value');
  const lines = text.split('\n');
  let inScope = options.path === undefined;
  let changed = 0;
  const wanted = name.toLowerCase();
  const result = lines.map((current) => {
    if (current !== '' && !/^\s/.test(current)) {
      if (options.path !== undefined) inScope = current.trim() === options.path;
      return current;
    }
    const match = /^(\s+)([^:\s][^:]*):/.exec(current);
    if (inScope && match && match[2]!.trim().toLowerCase() === wanted) {
      changed += 1;
      return `${match[1]}${match[2]}: ${value}`;
    }
    return current;
  });
  if (changed === 0) {
    throw new SecurityHeadersError('missing_header', `_headers has no ${name}${options.path === undefined ? '' : ` for ${options.path}`}`);
  }
  return result.join('\n');
}
