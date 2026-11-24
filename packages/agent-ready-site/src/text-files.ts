import { escapeHtml } from './html.js';
import { mirrorRoute, shortTitle } from './routes.js';

export interface TextPage {
  /** Route, such as `/guide/`. */
  readonly url: string;
  readonly title: string;
  readonly description: string;
  /** The page text, from `htmlToText`. */
  readonly text: string;
}

export interface TextPart {
  /** File name inside the preload folder, such as `02-guide.txt`. */
  readonly file: string;
  readonly title: string;
  readonly pages: readonly TextPage[];
  readonly text: string;
}

export interface DataLink {
  readonly title: string;
  readonly url: string;
  readonly note: string;
}

export interface TextFilesOptions {
  readonly origin: string;
  /** Site name, used in headings and to shorten page titles. */
  readonly name: string;
  /** Opening paragraphs of the preload page; the first one is also the quote under the `llms.txt` heading. */
  readonly summary: readonly string[];
  /** URL parts that make one text part: `2` groups `/games/x/a/` and `/games/x/b/` under `/games/x/`. */
  readonly groupDepth: number;
  /** Largest size of a part in characters; a group over it splits at page boundaries. */
  readonly partBudget: number;
  /** A site whose full text is at most this many characters is also written into the preload page. */
  readonly inlineBudget: number;
  /** Markdown sections of `llms.txt` that come before the full-text links. */
  readonly guide?: string | undefined;
  /** Machine-readable files to list beside the text files. */
  readonly data?: readonly DataLink[] | undefined;
  /** Route of the preload page and its folder, `/preload-for-agents` by default. */
  readonly preloadRoute?: string | undefined;
  /** Let small neighbouring groups share a part (a part's address then moves when a neighbour grows). Off by default. */
  readonly mergeSmallParts?: boolean | undefined;
  /** List and write the parts when there is only one. On by default; with one part its text is `all.txt` again. */
  readonly listSinglePart?: boolean | undefined;
}

export const DEFAULT_PRELOAD_ROUTE = '/preload-for-agents';

function preloadRoute(options: Pick<TextFilesOptions, 'preloadRoute'>): string {
  return options.preloadRoute ?? DEFAULT_PRELOAD_ROUTE;
}

/** One page as it appears in a text file: a banner with its URL, title and description, then its text. */
export function pageText(page: TextPage, origin: string): string {
  const head = [`URL: ${origin}${page.url}`, `Title: ${page.title}`];
  if (page.description) head.push(`Description: ${page.description}`);
  return `========================================\n${head.join('\n')}\n========================================\n\n${page.text}\n`;
}

/** The Markdown copy of one page: its canonical URL and description, then the page text. */
export function mirrorText(page: TextPage, origin: string): string {
  const head = [`Canonical page: ${origin}${page.url}`];
  if (page.description) head.push(`Description: ${page.description}`);
  return `${head.join('\n')}\n\n${page.text.trimEnd()}\n`;
}

function groupKey(url: string, depth: number): string {
  const parts = url.split('/').filter(Boolean);
  return parts.length ? `/${parts.slice(0, depth).join('/')}/` : '/';
}

function slugOf(key: string): string {
  return (
    key
      .replace(/^\/|\/$/g, '')
      .replace(/\+/g, '-plus')
      .replace(/[^a-z0-9]+/gi, '-')
      .toLowerCase() || 'home'
  );
}

interface Chunk {
  readonly label: string;
  readonly slug: string;
  readonly pages: readonly TextPage[];
  readonly size: number;
  readonly isSplit: boolean;
}

/**
 * One part per URL group (a section and its sub-pages), so a part's address does not move when another page grows.
 * A group over the budget splits at page boundaries. Pages keep their order; the group of the first page comes first.
 */
export function splitParts(pages: readonly TextPage[], options: Pick<TextFilesOptions, 'origin' | 'name' | 'groupDepth' | 'partBudget' | 'mergeSmallParts' | 'preloadRoute'>): TextPart[] {
  const groups = new Map<string, TextPage[]>();
  for (const page of pages) {
    const key = groupKey(page.url, options.groupDepth);
    const group = groups.get(key) ?? [];
    group.push(page);
    groups.set(key, group);
  }
  const chunks: Chunk[] = [];
  for (const [key, group] of groups) {
    const pieces: TextPage[][] = [[]];
    let size = 0;
    for (const page of group) {
      const pageSize = pageText(page, options.origin).length;
      const current = pieces[pieces.length - 1] ?? [];
      if (current.length && size + pageSize > options.partBudget) {
        pieces.push([page]);
        size = pageSize;
      } else {
        current.push(page);
        size += pageSize;
      }
    }
    const label = shortTitle(group[0]?.title ?? key, options.name);
    pieces.forEach((piece, index) => {
      const isSplit = pieces.length > 1;
      chunks.push({
        label: isSplit ? `${label}, section ${index + 1} of ${pieces.length}` : label,
        slug: isSplit ? `${slugOf(key)}-${index + 1}` : slugOf(key),
        pages: piece,
        size: piece.reduce((total, page) => total + pageText(page, options.origin).length, 0),
        isSplit,
      });
    });
  }
  let merged: Chunk[] = chunks;
  if (options.mergeSmallParts) {
    merged = [];
    for (const chunk of chunks) {
      const last = merged[merged.length - 1];
      if (last && !chunk.isSplit && !last.isSplit && last.size + chunk.size <= options.partBudget) {
        merged[merged.length - 1] = { ...last, label: `${last.label}; ${chunk.label}`, pages: [...last.pages, ...chunk.pages], size: last.size + chunk.size };
      } else merged.push(chunk);
    }
  }
  const index = `${options.origin}${preloadRoute(options)}`;
  return merged.map((chunk, number) => ({
    file: `${String(number + 1).padStart(2, '0')}-${chunk.slug}.txt`,
    title: chunk.label,
    pages: chunk.pages,
    text: `${options.name}: preload for agents, part ${number + 1} of ${merged.length}\n${chunk.label}\nIndex: ${index}\nPages in this part: ${chunk.pages.length}\n\n${chunk.pages
      .map((page) => pageText(page, options.origin))
      .join('\n')}`,
  }));
}

/** Every page in one text: the content of `llms-full.txt` and of the preload folder's `all.txt`. */
export function fullText(pages: readonly TextPage[], options: Pick<TextFilesOptions, 'origin' | 'name' | 'preloadRoute'>): string {
  return `${options.name}: every page as plain text\nIndex: ${options.origin}${preloadRoute(options)}\nPages: ${pages.length}\n\n${pages
    .map((page) => pageText(page, options.origin))
    .join('\n')}`;
}

function formatSize(chars: number): string {
  return chars < 10_000 ? `${(chars / 1000).toFixed(1)}k characters` : `${Math.round(chars / 1000)}k characters`;
}

function pageCount(count: number): string {
  return `${count} page${count === 1 ? '' : 's'}`;
}

/** The plain HTML index page of the text files: no scripts, links to the parts, data files and every page's Markdown copy. */
export function preloadPageHtml(options: TextFilesOptions, pages: readonly TextPage[], parts: readonly TextPart[], all: string): string {
  const preloadUrl = `${options.origin}${preloadRoute(options)}`;
  const isInline = all.length <= options.inlineBudget;
  const partRows = parts
    .map(
      (part, index) =>
        `<li><a href="${preloadUrl}/${part.file}">Part ${index + 1}: ${escapeHtml(part.title)}</a> (${pageCount(part.pages.length)}, ${formatSize(part.text.length)})</li>`,
    )
    .join('\n');
  const dataRows = (options.data ?? [])
    .map((link) => `<li><a href="${escapeHtml(link.url)}">${escapeHtml(link.title)}</a>: ${escapeHtml(link.note)}</li>`)
    .join('\n');
  const pageRows = pages
    .map(
      (page) =>
        `<li><a href="${options.origin}${page.url}">${escapeHtml(shortTitle(page.title, options.name))}</a> (<a href="${options.origin}${mirrorRoute(page.url)}">Markdown</a>)</li>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(options.name)}: preload for agents</title>
<meta name="description" content="${escapeHtml(`Everything on ${options.name} as plain text for AI agents and readers without JavaScript.`)}">
<link rel="canonical" href="${preloadUrl}">
<link rel="describedby" href="/llms.txt" type="text/plain">
<link rel="alternate" type="text/plain" href="${preloadUrl}/all.txt">
</head>
<body>
<main>
<h1>${escapeHtml(options.name)}: preload for agents</h1>
${options.summary.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join('\n')}
<h2>How to read this</h2>
<ul>
<li>This page and the files it links are plain text and HTML. They need no JavaScript and no sign-in.</li>
<li>They are generated from the site's own pages when the site is built, so they say what ${escapeHtml(options.origin)} shows a visitor, and nothing more.</li>
<li>${pageCount(pages.length)}, ${formatSize(all.length)} in total. Each page in the text starts with its URL and title.</li>
<li><a href="${options.origin}/llms.txt">llms.txt</a> is the reading guide: what each page covers and how the numbers are defined.</li>
</ul>
<h2>Full text</h2>
<ul>
<li><a href="${preloadUrl}/all.txt">Every page in one file</a> (${formatSize(all.length)})</li>
${partRows}
</ul>
${dataRows ? `<h2>Data</h2>\n<ul>\n${dataRows}\n</ul>\n` : ''}<h2>Pages</h2>
<ul>
${pageRows}
</ul>
${isInline ? `<h2>Every page</h2>\n<pre style="white-space: pre-wrap">${escapeHtml(all)}</pre>` : ''}
</main>
</body>
</html>
`;
}

/** `llms.txt`: the site name and summary, the caller's reading guide, then links to the full text and its parts. */
export function llmsTxt(options: TextFilesOptions, parts: readonly TextPart[], all: string): string {
  const preloadUrl = `${options.origin}${preloadRoute(options)}`;
  const guide = options.guide?.trim();
  return `# ${options.name}

> ${options.summary[0] ?? ''}

This file is a reading guide to ${options.origin}/ for AI agents and other readers. Every link below is a public page or file on the site.

${guide ? `${guide}\n\n` : ''}## Full text

The whole site as plain text. ${preloadUrl} is an index page that links the same files.

${[
  `- [Every page in one file](${preloadUrl}/all.txt): ${formatSize(all.length)}, also served as [llms-full.txt](${options.origin}/llms-full.txt)`,
  ...parts.map((part, index) => `- [Part ${index + 1}: ${part.title}](${preloadUrl}/${part.file}): ${formatSize(part.text.length)}`),
].join('\n')}
`;
}
