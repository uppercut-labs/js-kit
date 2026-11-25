# @uppercut-labs/agent-ready-site

Make a static site readable by agents and by readers that run no scripts: per-page head tags with JSON-LD, a Markdown copy of every page, `sitemap.xml` and `sitemap.md`, `llms.txt` and `llms-full.txt`, plain-text parts, `robots.txt` with a crawler allow policy and a check for it, and `Link` headers for a Cloudflare Pages `_headers` file. Everything is written from the pages the site already publishes, so it can never say more than a visitor can see.

```sh
npm install @uppercut-labs/agent-ready-site
```

The package depends only on [`@uppercut-labs/security-headers`](../security-headers) (it writes the `_headers` text with `buildHeadersFile`). The main entry has no Node imports. `@uppercut-labs/agent-ready-site/node` reads and writes the build folder and needs Node 18+.

Site names, titles, paths, origins and crawler lists are all arguments. Nothing about a particular site is built in.

## A build step

Run it after every page is written to `dist/`:

```ts
import { writeFileSync } from 'node:fs';
import { agentHeadersFile, robotsTxt, sitemapXml, webPageEntity } from '@uppercut-labs/agent-ready-site';
import { decoratePages, readSitemapOrder, writeAgentFiles } from '@uppercut-labs/agent-ready-site/node';

const origin = 'https://example.test';
const name = 'Example Site';
const routes = ['/', '/guide/']; // the pages your build wrote

// 1. Head tags on every page: canonical, describedby, Markdown alternate, Open Graph, JSON-LD.
decoratePages({ dist: 'dist', origin, name, jsonLd: ({ route, title, description }) => webPageEntity({ url: origin + route, name: title, description }) });

// 2. Markdown copies, llms.txt, llms-full.txt, sitemap.md and the preload page and parts.
const written = writeAgentFiles({
  dist: 'dist',
  origin,
  name,
  summary: ['Example Site is a demo.'],
  guide: '## Pages\n\n- [Home](https://example.test/): what the site is.',
  order: readSitemapOrder('dist', origin), // the site's own reading order
  groupDepth: 2,
  partBudget: 100_000,
  inlineBudget: 60_000,
});

// 3. The files that are not derived from pages.
writeFileSync('dist/sitemap.xml', sitemapXml(origin, [...routes, ...written.files]));
writeFileSync('dist/robots.txt', robotsTxt({ groups: [{ userAgent: '*', allow: ['/'] }, { userAgent: 'Example-Bot', allow: ['/docs/'] }], sitemaps: [`${origin}/sitemap.xml`] }));
writeFileSync('dist/_headers', agentHeadersFile({ headers: { 'X-Content-Type-Options': 'nosniff' } }));
```

A site that renders its own pages (a template or React) can call `headTags` per page instead of `decoratePages`, and keep the rest.

## Head tags

- `headTags({ origin, route, title, description?, siteName?, ogTitle?, ogType?, image?, metaDescription?, guide?, mirror?, jsonLd? })` returns the tags, one per line, escaped for attributes: `canonical`, a `describedby` link to the guide (`/llms.txt`), an `alternate` link to the page's Markdown copy, Open Graph tags and the JSON-LD block. `guide: false` and `mirror: false` leave a link out.
- `webPageEntity({ url, name, description?, type?, inLanguage?, site?, about?, extra? })` is a schema.org page: `type` is `WebPage` unless you pass `CollectionPage`, `TechArticle` and the like; `site` writes `isPartOf`; `about` and `extra` are yours.
- `jsonLdScript(entityOrList)` writes the `<script type="application/ld+json">` block with `<`, `>` and `&` escaped, so page data cannot close it early. A list becomes one `@graph`.
- `injectHead(html, tags)` puts tags before `</head>`. It throws when the page already has a canonical link or has no `</head>`, so a page is never decorated twice. `NOINDEX_TAG` is the tag for a 404.
- `decoratePages(options)` (node) does it for every public page of a build folder, reading title and description from the page. `jsonLd(page)` and `tags(page)` choose per page JSON-LD and other `headTags` fields. The 404 page and the preload page are skipped.

## Markdown copies and text files

`writeAgentFiles(options)` (node) reads the finished HTML (the `<main>` of each page, or the body) and writes:

| File | Content |
| --- | --- |
| `/<route>/index.md`, `/<route>.md` | The Markdown copy of each page: `Canonical page: URL`, `Description: ...`, then the page text |
| `/llms.txt` | `# Name`, the first `summary` paragraph, your `guide` Markdown, then links to the full text and its parts |
| `/llms-full.txt` and `/preload-for-agents/all.txt` | Every page as plain text, each starting with a banner of its URL, title and description |
| `/preload-for-agents/NN-group.txt` | The same text in parts, one per URL group (`groupDepth` segments), split at page boundaries when a group is over `partBudget` characters |
| `/preload-for-agents.html` | A script-free index page: summary, links to the parts and `data` files, every page with its Markdown copy, and the full text inline when it is at most `inlineBudget` characters |
| `/sitemap.md` | Every page in reading order with its Markdown copy |

It returns `{ pages, parts, chars, files }`; `files` lists every route written so they can go in `sitemap.xml`. The preload folder is emptied before it is written. Options:

| Option | Meaning |
| --- | --- |
| `order` | Routes in reading order, such as `readSitemapOrder(dist, origin)`. Pages not listed follow alphabetically |
| `data` | `[{ title, url, note }]`: machine-readable files to list on the preload page |
| `preloadRoute` | `/preload-for-agents` by default |
| `mergeSmallParts` | Let small neighbouring groups share a part. Off, so a part's address does not move when another group grows |
| `listSinglePart` | `false` writes no part files and lists none when everything fits in one |
| `statusClass` | A `<span class="NAME">label</span>` reads as `(label)` instead of running into its link text |
| `exclude` | More routes to leave out of every file |

`htmlToText(html, { origin, page, statusClass? })` is the converter on its own: headings, prose, lists, tables (a row that starts with a heading reads `Heading: cell · cell`, any other table becomes a pipe table), code with its exact white space, links made absolute, labelled images and SVG as `[Image: label]`. Scripts, styles, buttons, form controls and their labels are dropped. The pure pieces behind the writer (`splitParts`, `fullText`, `llmsTxt`, `preloadPageHtml`, `mirrorText`, `pageText`) are exported too.

## Sitemaps, robots and headers

- `sitemapXml(origin, routes)`, `sitemapRoutes(xmlText, origin)` and `sitemapMarkdown({ name, origin, pages })`.
- `robotsTxt({ groups?, sitemaps? })` writes the groups (`{ userAgent, allow?, disallow? }`) separated by a blank line, then a `Sitemap:` line each. With no groups it allows everyone. `crawlerAllowPolicy(agent, paths)` writes one crawler's `Allow` list. A line break in any value throws, so a configured value cannot add a rule.
- `crawlerAllows(robots, agent, path)` answers as the standard does: the group that names the crawler is used alone (otherwise `*`), the longest matching rule wins, `Allow` wins a tie, `*` and a final `$` work. `assertCrawlerAccess(robots, agent, paths, { rejectPatterns? })` throws on the first blocked path; `rejectPatterns` also throws on any `*` or `$` rule for that agent so a person reviews it.
- `assertServedRobots(servedText, builtText, { agent, paths, knownPrefixes? })` (node) is the deployment check. The built policy must be the end of the served file; anything before it (a managed block a host adds) must match the SHA-256 of a prefix you pinned in `knownPrefixes`; and the crawler must be able to reach every path.
- `agentHeadersFile({ guide?, homeMirror?, headers?, rules? })` is the text of a `_headers` file: a `Link: </llms.txt>; rel="describedby"` header on every path, a `Link` to `/index.md` on `/`, your `headers` for every path and your `rules` after. `agentHeaderRules` returns the same as `HeadersRule[]` for `buildHeadersFile` from `@uppercut-labs/security-headers`.

## Tests

The suite builds temporary sites from synthetic pages (example.test origins) and checks every file the writer produces, the converter on the page shapes the replaced copies handled, the crawler rules and the deployment check, and compares the robots, sitemap and `_headers` text with the hand-written strings this package replaces.

## License

MIT
