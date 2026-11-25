export interface CrawlerGroup {
  /** One user agent or several that share the rules. */
  readonly userAgent: string | readonly string[];
  readonly allow?: readonly string[] | undefined;
  readonly disallow?: readonly string[] | undefined;
}

function line(value: string, what: string): string {
  if (/[\r\n]/.test(value)) throw new Error(`${what} must be one line`);
  return value;
}

function groupText(group: CrawlerGroup): string {
  const agents = typeof group.userAgent === 'string' ? [group.userAgent] : group.userAgent;
  if (!agents.length) throw new Error('A crawler group needs a user agent');
  return `${[
    ...agents.map((agent) => `User-agent: ${line(agent, 'A user agent')}`),
    ...(group.allow ?? []).map((path) => `Allow: ${line(path, 'A path')}`),
    ...(group.disallow ?? []).map((path) => `Disallow: ${line(path, 'A path')}`),
  ].join('\n')}\n`;
}

/** The policy for one crawler: `User-agent: NAME`, then an `Allow:` line per path. Paths are written as given. */
export function crawlerAllowPolicy(agent: string, paths: readonly string[]): string {
  return groupText({ userAgent: agent, allow: paths });
}

/**
 * `robots.txt` text: the groups in order, separated by a blank line, then a `Sitemap:` line per sitemap.
 * With no groups it allows every crawler everywhere.
 */
export function robotsTxt(input: { readonly groups?: readonly CrawlerGroup[] | undefined; readonly sitemaps?: readonly string[] | undefined }): string {
  const groups = input.groups?.length ? input.groups : [{ userAgent: '*', allow: ['/'] }];
  return `${groups.map(groupText).join('\n')}${(input.sitemaps ?? []).map((url) => `Sitemap: ${line(url, 'A sitemap URL')}\n`).join('')}`;
}

interface Rule {
  readonly allow: boolean;
  readonly path: string;
}
interface Group {
  readonly agents: string[];
  readonly rules: Rule[];
  /** A rule line (even an empty one) was read, so the next `User-agent` line starts a new group. */
  closed: boolean;
}

/** Groups of a robots.txt, as the standard reads them: consecutive `User-agent` lines share the rules that follow; empty values are ignored. */
export function parseRobots(robots: string): { agents: string[]; rules: { allow: boolean; path: string }[] }[] {
  const groups: Group[] = [];
  let group: Group | undefined;
  for (const raw of robots.split(/\r?\n/)) {
    const match = /^(user-agent|allow|disallow)\s*:\s*(.*)$/i.exec(raw.split('#')[0]!.trim());
    if (!match) continue;
    const key = match[1]!.toLowerCase();
    const value = match[2]!.trim();
    if (key === 'user-agent') {
      if (!group || group.closed) {
        group = { agents: [], rules: [], closed: false };
        groups.push(group);
      }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      group.closed = true;
      if (value) group.rules.push({ allow: key === 'allow', path: value });
    }
  }
  return groups.map(({ agents, rules }) => ({ agents, rules }));
}

function pattern(path: string): RegExp {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path).replace(/[.+?^{}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
}

/**
 * Whether a crawler may fetch a path under a robots.txt. The group that names the agent is used alone; without one the `*` group is.
 * The longest matching rule wins and `Allow` beats `Disallow` on a tie. `*` and a final `$` in a rule work as the standard says.
 */
export function crawlerAllows(robots: string, agent: string, path: string): boolean {
  const groups = parseRobots(robots);
  const wanted = agent.toLowerCase();
  const named = groups.filter((group) => group.agents.includes(wanted));
  const rules = (named.length ? named : groups.filter((group) => group.agents.includes('*'))).flatMap((group) => group.rules);
  const matched = rules.filter((rule) => pattern(rule.path).test(path)).sort((a, b) => b.path.length - a.path.length || Number(b.allow) - Number(a.allow));
  return matched[0]?.allow ?? true;
}

export interface CrawlerAccessOptions {
  /** Throw on a rule with `*` or `$` for this agent instead of interpreting it, so a human reviews pattern rules. */
  readonly rejectPatterns?: boolean | undefined;
}

/** Throw when a crawler is blocked from any of the paths. */
export function assertCrawlerAccess(robots: string, agent: string, paths: readonly string[], options: CrawlerAccessOptions = {}): void {
  if (options.rejectPatterns) {
    const wanted = agent.toLowerCase();
    const groups = parseRobots(robots);
    const named = groups.filter((group) => group.agents.includes(wanted));
    for (const rule of (named.length ? named : groups.filter((group) => group.agents.includes('*'))).flatMap((group) => group.rules))
      if (/[*$]/.test(rule.path)) throw new Error(`Review the ${agent} pattern rule ${rule.path} before declaring the paths reachable.`);
  }
  for (const path of paths) if (!crawlerAllows(robots, agent, path)) throw new Error(`${agent} is blocked from ${path} by robots.txt`);
}
