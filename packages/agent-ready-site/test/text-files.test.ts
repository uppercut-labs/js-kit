import { describe, expect, it } from 'vitest';
import { fullText, llmsTxt, mirrorText, pageText, preloadPageHtml, splitParts, type TextFilesOptions, type TextPage } from '../src/index.js';

const ORIGIN = 'https://example.test';
const options: TextFilesOptions = { origin: ORIGIN, name: 'Site', summary: ['A test site.', 'More.'], groupDepth: 2, partBudget: 100_000, inlineBudget: 60_000 };
const page = (url: string, text: string, title = url): TextPage => ({ url, title: `${title} | Site`, description: '', text });

describe('page text', () => {
  it('starts a page with a banner holding its URL, title and description', () => {
    expect(pageText({ url: '/a/', title: 'A', description: 'About A', text: 'body' }, ORIGIN)).toBe(
      '========================================\nURL: https://example.test/a/\nTitle: A\nDescription: About A\n========================================\n\nbody\n',
    );
    expect(pageText(page('/a/', 'body'), ORIGIN)).not.toContain('Description:');
  });

  it('writes the Markdown copy of a page', () => {
    expect(mirrorText({ url: '/a/', title: 'A', description: 'About A', text: 'body\n\n' }, ORIGIN)).toBe(
      'Canonical page: https://example.test/a/\nDescription: About A\n\nbody\n',
    );
  });
});

describe('splitParts', () => {
  const long = 'x'.repeat(400);
  const pages = [
    page('/', 'home', 'Home'),
    page('/about/', 'about', 'About'),
    ...Array.from({ length: 6 }, (_: unknown, i: number) => page(`/games/a/${i}/`, long, `A ${i}`)),
    page('/games/b/', 'b', 'B'),
  ];
  const urls = (parts: ReturnType<typeof splitParts>) => parts.flatMap((part) => part.pages.map((p) => p.url));

  it('makes one part per URL group, keeping every page once in order within its group', () => {
    const parts = splitParts(pages, { ...options, partBudget: 100_000 });
    expect(parts.map((part) => part.file)).toEqual(['01-home.txt', '02-about.txt', '03-games-a.txt', '04-games-b.txt']);
    expect(parts.map((part) => part.title)).toEqual(['Home', 'About', 'A 0', 'B']);
    expect(urls(parts)).toEqual(pages.map((p) => p.url));
    expect(parts[2]?.text.startsWith('Site: preload for agents, part 3 of 4\nA 0\nIndex: https://example.test/preload-for-agents\nPages in this part: 6\n')).toBe(true);
  });

  it('splits a group over the budget at page boundaries', () => {
    const parts = splitParts(pages, { ...options, partBudget: 1200 });
    const games = parts.filter((part) => part.file.includes('games-a'));
    expect(games.length).toBeGreaterThan(1);
    expect(games[0]?.title).toBe('A 0, section 1 of ' + games.length);
    expect(games[0]?.file).toBe('03-games-a-1.txt');
    expect(urls(parts)).toEqual(pages.map((p) => p.url));
    expect(games.every((part) => part.pages.length === 1 || part.pages.reduce((n, p) => n + pageText(p, ORIGIN).length, 0) <= 1200)).toBe(true);
  });

  it('can let small neighbours share a part and never merges a split group', () => {
    const parts = splitParts(pages, { ...options, partBudget: 1200, mergeSmallParts: true });
    expect(parts[0]?.pages.map((p) => p.url)).toEqual(['/', '/about/']);
    expect(parts[0]?.title).toBe('Home; About');
    expect(parts[1]?.title).toContain('section 1 of');
    expect(urls(parts)).toEqual(pages.map((p) => p.url));
  });

  it('uses a custom preload route and names a root group "home"', () => {
    const [part] = splitParts([page('/', 'x')], { ...options, preloadRoute: '/for-agents' });
    expect(part?.file).toBe('01-home.txt');
    expect(part?.text).toContain('Index: https://example.test/for-agents\n');
  });

  it('turns + into -plus in a part file name', () => {
    expect(splitParts([page('/x+/', 'x')], options)[0]?.file).toBe('01-x-plus.txt');
  });
});

describe('llms.txt and the preload page', () => {
  const pages = [page('/', 'home', 'Home'), page('/a/', 'a <b>', 'A')];
  const parts = splitParts(pages, options);
  const all = fullText(pages, options);

  it('writes the full text with its banner', () => {
    expect(all.startsWith('Site: every page as plain text\nIndex: https://example.test/preload-for-agents\nPages: 2\n\n===')).toBe(true);
  });

  it('starts llms.txt with the name and first summary paragraph, then the guide, then the full-text links', () => {
    const llms = llmsTxt({ ...options, guide: '\n## Pages\n\n- [Home](https://example.test/)\n' }, parts, all);
    expect(llms.startsWith('# Site\n\n> A test site.\n\nThis file is a reading guide to https://example.test/ for AI agents')).toBe(true);
    expect(llms.indexOf('## Pages')).toBeLessThan(llms.indexOf('## Full text'));
    expect(llms).toContain('- [Every page in one file](https://example.test/preload-for-agents/all.txt): 0.4k characters, also served as [llms-full.txt](https://example.test/llms-full.txt)\n- [Part 1: Home](https://example.test/preload-for-agents/01-home.txt)');
    expect(llms.endsWith('characters\n')).toBe(true);
  });

  it('needs no guide and lists no parts when none are given', () => {
    const llms = llmsTxt(options, [], all);
    expect(llms).not.toContain('Part 1');
    expect(llms.endsWith('(https://example.test/llms-full.txt)\n')).toBe(true);
  });

  it('writes a script-free preload page that escapes text and inlines a small site', () => {
    const html = preloadPageHtml(options, pages, parts, all);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('<link rel="canonical" href="https://example.test/preload-for-agents">');
    expect(html).toContain('<a href="https://example.test/a/">A</a> (<a href="https://example.test/a/index.md">Markdown</a>)');
    expect(html).toContain('<h2>Every page</h2>');
    expect(html).toContain('a &lt;b&gt;');
  });

  it('links instead of inlining a site over the inline budget, and lists data files', () => {
    const html = preloadPageHtml({ ...options, inlineBudget: 10, data: [{ title: 'data.json', url: 'https://example.test/data.json?a=1&b=2', note: 'the numbers' }] }, pages, parts, all);
    expect(html).not.toContain('<pre');
    expect(html).toContain('<li><a href="https://example.test/data.json?a=1&amp;b=2">data.json</a>: the numbers</li>');
    expect(html).toContain('01-home.txt');
  });
});
