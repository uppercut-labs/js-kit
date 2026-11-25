/**
 * Make a static site readable by agents: per-page head tags and JSON-LD, Markdown copies of every page, `sitemap.xml` and `sitemap.md`,
 * `llms.txt` and `llms-full.txt`, plain-text parts, `robots.txt` with a crawler policy and its check, and `Link` headers for `_headers`.
 * This entry has no Node imports; `@uppercut-labs/agent-ready-site/node` reads and writes the built site folder.
 */
export { decodeHtml, escapeHtml, htmlToText, textOf } from './html.js';
export type { HtmlToTextOptions } from './html.js';
export { mirrorRoute, routeOfFile, shortTitle } from './routes.js';
export { headTags, injectHead, jsonLdScript, NOINDEX_TAG, webPageEntity } from './head.js';
export type { HeadTagsInput, JsonLdEntity, WebPageEntityInput } from './head.js';
export { sitemapMarkdown, sitemapRoutes, sitemapXml } from './sitemap.js';
export type { SitemapMarkdownPage } from './sitemap.js';
export { assertCrawlerAccess, crawlerAllowPolicy, crawlerAllows, parseRobots, robotsTxt } from './robots.js';
export type { CrawlerAccessOptions, CrawlerGroup } from './robots.js';
export { agentHeaderRules, agentHeadersFile } from './headers.js';
export type { AgentHeadersOptions } from './headers.js';
export { DEFAULT_PRELOAD_ROUTE, fullText, llmsTxt, mirrorText, pageText, preloadPageHtml, splitParts } from './text-files.js';
export type { DataLink, TextFilesOptions, TextPage, TextPart } from './text-files.js';
