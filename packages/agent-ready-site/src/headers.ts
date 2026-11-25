import { buildHeadersFile, type HeadersRule } from '@uppercut-labs/security-headers';

export interface AgentHeadersOptions {
  /** Route of the reading guide, `/llms.txt` by default. `false` leaves the `describedby` link out. */
  readonly guide?: string | false | undefined;
  /** Route of the home page's Markdown copy, `/index.md` by default. `false` leaves it out. */
  readonly homeMirror?: string | false | undefined;
  /** Other headers for every path, written after the `Link` header. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** More rules, written after the first two. */
  readonly rules?: readonly HeadersRule[] | undefined;
}

/** The `_headers` rules that point a reader to the guide on every response and name the home page's Markdown copy. */
export function agentHeaderRules(options: AgentHeadersOptions = {}): HeadersRule[] {
  const guide = options.guide === undefined ? '/llms.txt' : options.guide;
  const homeMirror = options.homeMirror === undefined ? '/index.md' : options.homeMirror;
  const all = {
    ...(guide === false ? {} : { Link: `<${guide}>; rel="describedby"; type="text/plain"` }),
    ...options.headers,
  };
  return [
    ...(Object.keys(all).length ? [{ path: '/*', headers: all }] : []),
    ...(homeMirror === false ? [] : [{ path: '/', headers: { Link: `<${homeMirror}>; rel="alternate"; type="text/markdown"` } }]),
    ...(options.rules ?? []),
  ];
}

/** The text of a Cloudflare Pages `_headers` file from `agentHeaderRules`, written by `@uppercut-labs/security-headers`. */
export function agentHeadersFile(options: AgentHeadersOptions = {}): string {
  return buildHeadersFile(agentHeaderRules(options));
}
