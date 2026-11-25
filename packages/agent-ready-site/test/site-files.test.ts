import { describe, expect, it } from 'vitest';
import {
  agentHeaderRules,
  agentHeadersFile,
  assertCrawlerAccess,
  crawlerAllowPolicy,
  crawlerAllows,
  parseRobots,
  robotsTxt,
  sitemapMarkdown,
  sitemapRoutes,
  sitemapXml,
} from '../src/index.js';

const ORIGIN = 'https://example.test';

describe('sitemap', () => {
  it('writes sitemap.xml in the order given and escapes locations', () => {
    expect(sitemapXml(ORIGIN, ['/', '/a+/', '/q?a=1&b=2'])).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
        '<url><loc>https://example.test/</loc></url>\n<url><loc>https://example.test/a+/</loc></url>\n<url><loc>https://example.test/q?a=1&amp;b=2</loc></url>\n</urlset>\n',
    );
  });

  it('reads routes back, skipping other origins', () => {
    const xml = sitemapXml(ORIGIN, ['/', '/a/', '/q?a=1&b=2']).replace('</urlset>', '<url><loc>https://other.test/x/</loc></url></urlset>');
    expect(sitemapRoutes(xml, ORIGIN)).toEqual(['/', '/a/', '/q?a=1&b=2']);
    expect(sitemapRoutes('<loc>https://example.test</loc>', ORIGIN)).toEqual(['/']);
  });

  it('writes sitemap.md with each page and its Markdown copy', () => {
    expect(
      sitemapMarkdown({
        name: 'Site',
        origin: ORIGIN,
        pages: [
          { route: '/', title: 'Home | Site' },
          { route: '/a/', title: 'A [b]' },
          { route: '/c', title: 'C · Site' },
        ],
      }),
    ).toBe(
      '# Site sitemap\n\nEvery page, in the same order as https://example.test/sitemap.xml. Each page also has a Markdown copy (the "md" link).\n\n' +
        '- [Home](https://example.test/) ([md](https://example.test/index.md))\n' +
        '- [A \\[b\\]](https://example.test/a/) ([md](https://example.test/a/index.md))\n' +
        '- [C](https://example.test/c) ([md](https://example.test/c.md))\n',
    );
  });
});

describe('robotsTxt', () => {
  it('allows every crawler by default and names the sitemap', () => {
    expect(robotsTxt({ sitemaps: [`${ORIGIN}/sitemap.xml`] })).toBe('User-agent: *\nAllow: /\nSitemap: https://example.test/sitemap.xml\n');
  });

  it('separates groups by a blank line and writes shared user agents together', () => {
    const text = robotsTxt({
      groups: [
        { userAgent: '*', allow: ['/'] },
        { userAgent: ['Bot-A', 'Bot-B'], allow: ['/public/'], disallow: ['/private/'] },
      ],
      sitemaps: [`${ORIGIN}/sitemap.xml`, `${ORIGIN}/more/sitemap.xml`],
    });
    expect(text).toBe(
      'User-agent: *\nAllow: /\n\nUser-agent: Bot-A\nUser-agent: Bot-B\nAllow: /public/\nDisallow: /private/\nSitemap: https://example.test/sitemap.xml\nSitemap: https://example.test/more/sitemap.xml\n',
    );
  });

  it('writes a crawler allow policy', () => {
    expect(crawlerAllowPolicy('Example-Bot', ['/a/', '/b.md'])).toBe('User-agent: Example-Bot\nAllow: /a/\nAllow: /b.md\n');
  });

  it('refuses a line break that would add a rule', () => {
    expect(() => crawlerAllowPolicy('Bot', ['/a\nDisallow: /'])).toThrow(/one line/);
    expect(() => robotsTxt({ sitemaps: ['https://x.test/s.xml\nDisallow: /'] })).toThrow(/one line/);
    expect(() => robotsTxt({ groups: [{ userAgent: [] }] })).toThrow(/user agent/);
  });
});

describe('crawler access', () => {
  const policy = crawlerAllowPolicy('Example-Bot', ['/docs/', '/llms.txt']);
  const managed = 'User-agent: Example-Bot\nDisallow: /\n\nUser-agent: *\nAllow: /\n';

  it('uses the group that names the crawler and not the * group', () => {
    expect(crawlerAllows('User-agent: Example-Bot\nDisallow: /\n\nUser-agent: *\nAllow: /', 'Example-Bot', '/docs/a.md')).toBe(false);
    expect(crawlerAllows('User-agent: *\nDisallow: /private/', 'Example-Bot', '/docs/a.md')).toBe(true);
    expect(crawlerAllows('User-agent: *\nDisallow: /private/', 'Example-Bot', '/private/a')).toBe(false);
  });

  it('lets a longer Allow beat a shorter Disallow, and Allow win a tie', () => {
    expect(crawlerAllows(`${managed}\n${policy}`, 'Example-Bot', '/docs/a.md')).toBe(true);
    expect(crawlerAllows(`${managed}\n${policy}`, 'Example-Bot', '/other')).toBe(false);
    expect(crawlerAllows('User-agent: Bot\nAllow: /a\nDisallow: /a', 'Bot', '/a')).toBe(true);
  });

  it('understands * and a final $', () => {
    const robots = 'User-agent: Bot\nDisallow: /*.json$\nAllow: /public/*.json$';
    expect(crawlerAllows(robots, 'Bot', '/x/a.json')).toBe(false);
    expect(crawlerAllows(robots, 'Bot', '/x/a.json?v=1')).toBe(true);
    expect(crawlerAllows(robots, 'Bot', '/public/a.json')).toBe(true);
  });

  it('ignores comments, empty values and case of directive names, and merges groups of one agent', () => {
    const groups = parseRobots('# c\nUSER-AGENT: A # x\nDisallow:\n\nuser-agent: a\ndisallow: /z\nSitemap: https://x.test/s.xml');
    expect(groups).toEqual([
      { agents: ['a'], rules: [] },
      { agents: ['a'], rules: [{ allow: false, path: '/z' }] },
    ]);
    expect(crawlerAllows('User-agent: A\nAllow: /\n\nUser-agent: a\nDisallow: /z', 'A', '/z')).toBe(false);
  });

  it('throws when a path is blocked, and names it', () => {
    expect(() => assertCrawlerAccess(managed, 'Example-Bot', ['/docs/a.md'])).toThrow(/Example-Bot is blocked from \/docs\/a\.md/);
    expect(() => assertCrawlerAccess(`${managed}\n${policy}`, 'Example-Bot', ['/docs/a.md', '/llms.txt'])).not.toThrow();
    expect(() => assertCrawlerAccess(`${managed}\n${policy}\nDisallow: /docs/a.md`, 'Example-Bot', ['/docs/a.md'])).toThrow(/blocked/);
  });

  it('can refuse pattern rules for the crawler instead of interpreting them', () => {
    expect(() => assertCrawlerAccess('User-agent: Bot\nAllow: /*', 'Bot', ['/a'], { rejectPatterns: true })).toThrow(/pattern rule/);
    expect(() => assertCrawlerAccess('User-agent: *\nAllow: /*', 'Bot', ['/a'], { rejectPatterns: true })).toThrow(/pattern rule/);
    expect(() => assertCrawlerAccess('User-agent: Bot\nAllow: /a', 'Bot', ['/a'], { rejectPatterns: true })).not.toThrow();
  });
});

describe('Link headers', () => {
  it('writes the guide link on every path and the home page Markdown link', () => {
    expect(agentHeadersFile()).toBe('/*\n  Link: </llms.txt>; rel="describedby"; type="text/plain"\n\n/\n  Link: </index.md>; rel="alternate"; type="text/markdown"\n');
  });

  it('adds the site headers after the Link header and more rules after the two', () => {
    expect(
      agentHeadersFile({
        headers: { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' },
        rules: [{ path: '/llms.txt', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }],
      }),
    ).toBe(
      '/*\n  Link: </llms.txt>; rel="describedby"; type="text/plain"\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n\n' +
        '/\n  Link: </index.md>; rel="alternate"; type="text/markdown"\n\n/llms.txt\n  Content-Type: text/plain; charset=utf-8\n',
    );
  });

  it('can leave either link out and use other routes', () => {
    expect(agentHeaderRules({ guide: false, homeMirror: false })).toEqual([]);
    expect(agentHeaderRules({ guide: '/guide.txt', homeMirror: false })).toEqual([{ path: '/*', headers: { Link: '</guide.txt>; rel="describedby"; type="text/plain"' } }]);
    expect(agentHeadersFile({ guide: false, homeMirror: '/home.md' })).toBe('/\n  Link: </home.md>; rel="alternate"; type="text/markdown"\n');
  });

  it('refuses a header value with a line break', () => {
    expect(() => agentHeadersFile({ headers: { 'X-A': 'a\nSet-Cookie: b=1' } })).toThrow();
  });
});
