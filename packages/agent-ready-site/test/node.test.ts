import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { crawlerAllowPolicy, robotsTxt, sitemapXml, webPageEntity } from '../src/index.js';
import { assertServedRobots, decoratePages, readSitemapOrder, readTextPages, sitePages, writeAgentFiles } from '../src/node.js';

const ORIGIN = 'https://example.test';
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function page(title: string, main: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} | Site</title><meta name="description" content="About ${title} &amp; more"></head><body><nav>chrome</nav><main id="main">${main}</main><footer>footer</footer><script>window.x=1</script></body></html>`;
}

function dist(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-ready-site-'));
  dirs.push(dir);
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
  }
  return dir;
}

const read = (dir: string, file: string): string => fs.readFileSync(path.join(dir, file), 'utf8');

const SITE = {
  'index.html': page('Home', '<h1>Home</h1><p>See <a href="/games/g/">the game</a>.</p>'),
  'games/g/index.html': page('Game', '<h1>Game</h1><p>CRC <code>F233A433</code></p>'),
  'games/g/code/index.html': page('Code', '<h1>Code</h1><pre>[Code]\npatch=1\n  indented &lt;x&gt;</pre>'),
  'about.html': page('About', '<h1>About</h1>'),
  '404.html': page('Not found', '<h1>404</h1>'),
  'preload-for-agents.html': '<html><head></head><body>old</body></html>',
};

describe('sitePages', () => {
  it('lists every public page sorted by route, without the 404 and the preload page', () => {
    expect(sitePages(dist(SITE)).map((p) => p.route)).toEqual(['/', '/about', '/games/g/', '/games/g/code/']);
    expect(sitePages(dist(SITE), { exclude: ['/about'] }).map((p) => p.route)).toEqual(['/', '/games/g/', '/games/g/code/']);
  });
});

describe('decoratePages', () => {
  it('adds the head tags to every public page and leaves the 404 and the preload page alone', () => {
    const dir = dist(SITE);
    const pages = decoratePages({
      
      dist: dir,
      origin: ORIGIN,
      name: 'Site',
      jsonLd: ({ route, title, description }) =>
        webPageEntity({ url: `${ORIGIN}${route}`, name: title, description, site: { name: 'Site', url: `${ORIGIN}/` } }),
    });
    expect(pages.map((p) => [p.route, p.title, p.description])).toEqual([
      ['/', 'Home | Site', 'About Home & more'],
      ['/about', 'About | Site', 'About About & more'],
      ['/games/g/', 'Game | Site', 'About Game & more'],
      ['/games/g/code/', 'Code | Site', 'About Code & more'],
    ]);
    for (const p of pages) {
      const html = read(dir, p.file);
      expect(html.match(/rel="canonical"/g)).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="${ORIGIN}${p.route}">`);
      expect(html).toContain('<meta property="og:site_name" content="Site">');
      expect(html).toContain('"@type":"WebPage"');
      expect(html).not.toContain('<meta name="description" content="About Home &amp; more"><meta name="description"');
    }
    expect(read(dir, '404.html')).toBe(SITE['404.html']);
    expect(read(dir, 'preload-for-agents.html')).toBe(SITE['preload-for-agents.html']);
    expect(read(dir, 'games/g/code/index.html')).toContain('href="https://example.test/games/g/code/index.md"');
  });

  it('refuses a page that already has a canonical link', () => {
    const dir = dist(SITE);
    decoratePages({ dist: dir, origin: ORIGIN, name: 'Site' });
    expect(() => decoratePages({ dist: dir, origin: ORIGIN, name: 'Site' })).toThrow(/canonical/);
  });

  it('passes per-page tag choices through', () => {
    const dir = dist({ 'index.html': page('Home', 'x') });
    decoratePages({ dist: dir, origin: ORIGIN, name: 'Site', metaDescription: true, tags: () => ({ ogType: 'article', image: `${ORIGIN}/i.png` }) });
    const html = read(dir, 'index.html');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="og:image" content="https://example.test/i.png">');
    expect(html).toContain('<meta name="description" content="About Home &amp; more">\n<meta property');
  });
});

describe('writeAgentFiles', () => {
  const base = { origin: ORIGIN, name: 'Site', summary: ['A test site.'], groupDepth: 2, partBudget: 100_000, inlineBudget: 60_000 };

  it('writes the Markdown copies, llms.txt, llms-full.txt, sitemap.md and the preload files from the built pages only', () => {
    const dir = dist({ ...SITE, 'sitemap.xml': sitemapXml(ORIGIN, ['/games/g/code/', '/', '/games/g/']) });
    const order = readSitemapOrder(dir, ORIGIN);
    expect(order).toEqual(['/games/g/code/', '/', '/games/g/']);
    const result = writeAgentFiles({ ...base, dist: dir, order, guide: '## Pages\n\n- [Home](https://example.test/)' });
    expect(result.pages).toBe(4);
    const all = read(dir, 'preload-for-agents/all.txt');
    expect(read(dir, 'llms-full.txt')).toBe(all);
    expect(all.indexOf('URL: https://example.test/games/g/code/\n')).toBeLessThan(all.indexOf('URL: https://example.test/\n'));
    expect(all.indexOf('URL: https://example.test/games/g/\n')).toBeLessThan(all.indexOf('URL: https://example.test/about\n'));
    expect(all).not.toMatch(/Not found|chrome|footer|window\.x/);
    expect(read(dir, 'games/g/code/index.md')).toBe(
      'Canonical page: https://example.test/games/g/code/\nDescription: About Code & more\n\n# Code\n\n```\n[Code]\npatch=1\n  indented <x>\n```\n',
    );
    expect(read(dir, 'index.md')).toContain('[the game](https://example.test/games/g/)');
    expect(read(dir, 'about.md')).toContain('# About');
    expect(fs.existsSync(path.join(dir, '404.md'))).toBe(false);
    expect(read(dir, 'sitemap.md')).toContain('- [Code](https://example.test/games/g/code/) ([md](https://example.test/games/g/code/index.md))');
    expect(read(dir, 'llms.txt')).toMatch(/^# Site\n\n> A test site\.\n/);
    const preload = read(dir, 'preload-for-agents.html');
    expect(preload).toContain('<h2>Every page</h2>');
    expect(preload).not.toContain('old');
    expect(result.files).toEqual(expect.arrayContaining(['/preload-for-agents', '/llms.txt', '/llms-full.txt', '/sitemap.md', '/preload-for-agents/all.txt', '/index.md', '/games/g/code/index.md']));
    for (const route of result.files) {
      const file = route.endsWith('/') ? `${route}index.html` : route;
      expect(fs.existsSync(path.join(dir, route === '/preload-for-agents' ? 'preload-for-agents.html' : file)), route).toBe(true);
    }
    for (const part of fs.readdirSync(path.join(dir, 'preload-for-agents'))) expect(preload.includes(part) || part === 'all.txt').toBe(true);
  });

  it('empties the preload folder before writing it', () => {
    const dir = dist({ ...SITE, 'preload-for-agents/99-stale.txt': 'stale' });
    writeAgentFiles({ ...base, dist: dir });
    expect(fs.existsSync(path.join(dir, 'preload-for-agents/99-stale.txt'))).toBe(false);
  });

  it('can leave out a single part and writes none then', () => {
    const dir = dist({ 'index.html': page('Home', 'x') });
    const result = writeAgentFiles({ ...base, dist: dir, listSinglePart: false });
    expect(result.parts).toBe(0);
    expect(fs.readdirSync(path.join(dir, 'preload-for-agents'))).toEqual(['all.txt']);
    expect(read(dir, 'llms.txt')).not.toContain('Part 1');
  });

  it('writes under another preload route and reads status chips when asked', () => {
    const dir = dist({ 'index.html': page('Home', '<p>Game <span class="chip ok">Matched</span></p>') });
    writeAgentFiles({ ...base, dist: dir, preloadRoute: '/for-agents', statusClass: 'chip' });
    expect(read(dir, 'for-agents/all.txt')).toContain('Game (Matched)');
    expect(read(dir, 'for-agents.html')).toContain('https://example.test/for-agents');
  });

  it('reads pages in the given order, then alphabetically, once each', () => {
    const dir = dist(SITE);
    const pages = readTextPages({ dist: dir, origin: ORIGIN, order: ['/games/g/', '/nope/', '/games/g/'] });
    expect(pages.map((p) => p.url)).toEqual(['/games/g/', '/', '/about', '/games/g/code/']);
  });

  it('has no sitemap order without a sitemap.xml', () => {
    expect(readSitemapOrder(dist(SITE), ORIGIN)).toEqual([]);
  });
});

describe('assertServedRobots', () => {
  const policy = crawlerAllowPolicy('Example-Bot', ['/docs/', '/llms.txt']);
  const built = robotsTxt({ groups: [{ userAgent: '*', allow: ['/'] }], sitemaps: [`${ORIGIN}/sitemap.xml`] }).replace('Sitemap', `\n${policy}\nSitemap`);
  const managed = '# BEGIN managed\nUser-agent: Example-Bot\nDisallow: /\n# END managed';
  const hash = createHash('sha256').update(managed).digest('hex');
  const options = { agent: 'Example-Bot', paths: ['/docs/a.md', '/llms.txt'] };

  it('accepts the built policy as served, and behind a pinned prefix', () => {
    expect(() => assertServedRobots(built, built, options)).not.toThrow();
    expect(() => assertServedRobots(`${managed}\n${built}`, built, { ...options, knownPrefixes: [hash] })).not.toThrow();
  });

  it('refuses a different policy, an unknown prefix and a blocked path', () => {
    expect(() => assertServedRobots(built.replace('example.test', 'other.test'), built, options)).toThrow(/differs/);
    expect(() => assertServedRobots(`${managed}\n${built}`, built, options)).toThrow(/Unrecognized/);
    expect(() => assertServedRobots(`${managed}\n${built}`, built, { ...options, knownPrefixes: ['0'.repeat(64)] })).toThrow(/Unrecognized/);
    const narrow = 'User-agent: Example-Bot\nDisallow: /docs/a.md';
    const narrowHash = createHash('sha256').update(narrow).digest('hex');
    expect(() => assertServedRobots(`${narrow}\n${built}`, built, { ...options, knownPrefixes: [narrowHash] })).toThrow(/blocked from \/docs\/a\.md/);
    expect(() => assertServedRobots(`${built}\nDisallow: /docs/a.md`, `${built}\nDisallow: /docs/a.md`, options)).toThrow(/blocked/);
  });
});
