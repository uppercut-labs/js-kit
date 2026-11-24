import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { headTags, injectHead, type HeadTagsInput, type JsonLdEntity } from './head.js';
import { decodeHtml, htmlToText, textOf } from './html.js';
import { assertCrawlerAccess, type CrawlerAccessOptions } from './robots.js';
import { mirrorRoute, routeOfFile } from './routes.js';
import { sitemapRoutes, sitemapMarkdown } from './sitemap.js';
import {
  DEFAULT_PRELOAD_ROUTE,
  fullText,
  llmsTxt,
  mirrorText,
  preloadPageHtml,
  splitParts,
  type TextFilesOptions,
  type TextPage,
} from './text-files.js';

/** A built page of the site. */
export interface SitePage {
  /** Route, such as `/guide/`. */
  readonly route: string;
  /** Path of the HTML file under the build folder, such as `guide/index.html`. */
  readonly file: string;
}

function htmlFiles(directory: string, root: string = directory): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...htmlFiles(fullPath, root));
    else if (entry.name.endsWith('.html')) files.push(path.relative(root, fullPath).split(path.sep).join('/'));
  }
  return files;
}

/**
 * The public HTML pages of a build folder, sorted by route: every page except `404.html` and the preload page itself.
 * `exclude` lists more routes to skip.
 */
export function sitePages(dist: string, options: { readonly preloadRoute?: string | undefined; readonly exclude?: readonly string[] | undefined } = {}): SitePage[] {
  const preload = `${(options.preloadRoute ?? DEFAULT_PRELOAD_ROUTE).slice(1)}.html`;
  return htmlFiles(dist)
    .filter((file) => file !== '404.html' && file !== preload)
    .map((file) => ({ route: routeOfFile(file), file }))
    .filter((page) => !options.exclude?.includes(page.route))
    .sort((a, b) => a.route.localeCompare(b.route));
}

/** The routes of `<dist>/sitemap.xml` on `origin` in file order, or an empty list when the file is missing. */
export function readSitemapOrder(dist: string, origin: string): string[] {
  const file = path.join(dist, 'sitemap.xml');
  return fs.existsSync(file) ? sitemapRoutes(fs.readFileSync(file, 'utf8'), origin) : [];
}

function mainOf(html: string): string {
  return /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(html)?.[1] ?? html;
}

function titleOf(html: string, route: string): string {
  return textOf(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? route);
}

function descriptionOf(html: string): string {
  return decodeHtml(/<meta name="description" content="([^"]*)"/i.exec(html)?.[1] ?? '');
}

export interface DecorateOptions {
  /** The build folder. */
  readonly dist: string;
  readonly origin: string;
  /** Site name for `og:site_name`. */
  readonly name: string;
  /** Add `<meta name="description">`; off by default because the page already has one (its description is read from it). */
  readonly metaDescription?: boolean | undefined;
  /** JSON-LD for a page, or nothing. Called with the page's route, title and description. */
  readonly jsonLd?: ((page: { readonly route: string; readonly title: string; readonly description: string }) => JsonLdEntity | readonly JsonLdEntity[] | undefined) | undefined;
  /** Other `headTags` fields for a page, such as `ogType` or `image`. */
  readonly tags?: ((page: { readonly route: string; readonly title: string; readonly description: string }) => Partial<HeadTagsInput>) | undefined;
  readonly preloadRoute?: string | undefined;
  readonly exclude?: readonly string[] | undefined;
}

/**
 * Add the agent `<head>` tags to every public built page, in place: canonical, `describedby`, Markdown alternate, Open Graph and JSON-LD.
 * Title and description are read from the page. A page that already has a canonical link makes the call throw before anything is written
 * to that page. Returns the pages with the titles and descriptions it used.
 */
export function decoratePages(options: DecorateOptions): (SitePage & { title: string; description: string })[] {
  return sitePages(options.dist, options).map((page) => {
    const fullPath = path.join(options.dist, page.file);
    const html = fs.readFileSync(fullPath, 'utf8');
    const title = titleOf(html, page.route);
    const description = descriptionOf(html);
    const info = { route: page.route, title, description };
    const tags = headTags({
      origin: options.origin,
      route: page.route,
      title,
      description,
      siteName: options.name,
      metaDescription: options.metaDescription,
      jsonLd: options.jsonLd?.(info),
      ...options.tags?.(info),
    });
    fs.writeFileSync(fullPath, injectHead(html, tags));
    return { ...page, title, description };
  });
}

export interface WriteSiteOptions extends TextFilesOptions {
  /** The build folder, after every page is written. */
  readonly dist: string;
  /** Routes in reading order (for example `readSitemapOrder`). Pages not listed follow in alphabetical order. */
  readonly order?: readonly string[] | undefined;
  /** See `htmlToText`. */
  readonly statusClass?: string | undefined;
  /** More routes to leave out of every file. */
  readonly exclude?: readonly string[] | undefined;
}

export interface WriteSiteResult {
  readonly pages: number;
  readonly parts: number;
  readonly chars: number;
  /** Route of every file written, for the sitemap. */
  readonly files: readonly string[];
}

/** Read every public built page as a `TextPage`, in `order`, then alphabetical order for the rest. */
export function readTextPages(options: Pick<WriteSiteOptions, 'dist' | 'origin' | 'order' | 'statusClass' | 'preloadRoute' | 'exclude'>): TextPage[] {
  const byRoute = new Map(sitePages(options.dist, options).map((page) => [page.route, page.file]));
  const routes = (options.order ?? []).filter((route, index, all) => byRoute.has(route) && all.indexOf(route) === index);
  for (const route of [...byRoute.keys()].sort()) if (!routes.includes(route)) routes.push(route);
  return routes.map((route) => {
    const html = fs.readFileSync(path.join(options.dist, byRoute.get(route) ?? ''), 'utf8');
    return {
      url: route,
      title: titleOf(html, route),
      description: descriptionOf(html),
      text: htmlToText(mainOf(html), { origin: options.origin, page: route, statusClass: options.statusClass }),
    };
  });
}

/**
 * Write the agent-facing text files from the finished HTML pages, so they say what a visitor already sees and nothing more:
 * a Markdown copy of every page, `llms.txt`, `llms-full.txt`, `sitemap.md`, the preload page and folder with `all.txt` and its parts.
 * The preload folder is emptied first. Returns the routes written, so they can be added to `sitemap.xml`.
 */
export function writeAgentFiles(options: WriteSiteOptions): WriteSiteResult {
  const preload = options.preloadRoute ?? DEFAULT_PRELOAD_ROUTE;
  const pages = readTextPages(options);
  const allParts = splitParts(pages, options);
  const parts = options.listSinglePart === false && allParts.length === 1 ? [] : allParts;
  const all = fullText(pages, options);
  const files = [preload, '/llms.txt', '/llms-full.txt', '/sitemap.md', `${preload}/all.txt`];
  const write = (route: string, content: string): void => {
    const file = path.join(options.dist, route);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  fs.rmSync(path.join(options.dist, preload.slice(1)), { recursive: true, force: true });
  write(`${preload}/all.txt`, all);
  write('/llms-full.txt', all);
  for (const part of parts) {
    write(`${preload}/${part.file}`, part.text);
    files.push(`${preload}/${part.file}`);
  }
  for (const page of pages) {
    write(mirrorRoute(page.url), mirrorText(page, options.origin));
    files.push(mirrorRoute(page.url));
  }
  write(`${preload}.html`, preloadPageHtml(options, pages, parts, all));
  write('/llms.txt', llmsTxt(options, parts, all));
  write('/sitemap.md', sitemapMarkdown({ name: options.name, origin: options.origin, pages: pages.map((page) => ({ route: page.url, title: page.title })) }));
  return { pages: pages.length, parts: parts.length, chars: all.length, files };
}

export interface ServedRobotsOptions extends CrawlerAccessOptions {
  /** The crawler the policy is about. */
  readonly agent: string;
  /** Paths the crawler must be able to fetch. */
  readonly paths: readonly string[];
  /** SHA-256 (hex) of each text the host may put before your policy, such as a managed block. Any other prefix throws. */
  readonly knownPrefixes?: readonly string[] | undefined;
}

/**
 * Check a robots.txt as served against the one the site builds: the built policy must be the end of the served file, anything before it
 * must be a prefix you pinned by hash, and the crawler must be able to reach every path.
 */
export function assertServedRobots(served: string, built: string, options: ServedRobotsOptions): void {
  const source = built.trimEnd();
  const actual = served.trimEnd();
  if (!source || !actual.endsWith(source)) throw new Error('The served robots.txt differs from the built source policy.');
  const prefix = actual.slice(0, -source.length).trim();
  if (prefix) {
    // Even another crawler rule in front of ours needs review, so only a pinned prefix passes.
    const hash = createHash('sha256').update(prefix).digest('hex');
    if (!options.knownPrefixes?.includes(hash)) throw new Error('Unrecognized robots.txt prefix; review the served policy.');
  }
  assertCrawlerAccess(served, options.agent, options.paths, options);
}
