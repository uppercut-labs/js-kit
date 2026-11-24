import { escapeHtml } from './html.js';
import { mirrorRoute } from './routes.js';

export type JsonLdEntity = Readonly<Record<string, unknown>>;

/**
 * A JSON-LD `<script>` block that cannot be closed early by its own data: `<`, `>` and `&` are written as `\uXXXX` escapes.
 * One entity gets `@context` added (unless it has one). An array becomes one `@graph`.
 */
export function jsonLdScript(entities: JsonLdEntity | readonly JsonLdEntity[]): string {
  const document = Array.isArray(entities)
    ? { '@context': 'https://schema.org', '@graph': entities }
    : { '@context': 'https://schema.org', ...(entities as JsonLdEntity) };
  const json = JSON.stringify(document).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  return `<script type="application/ld+json">${json}</script>`;
}

export interface WebPageEntityInput {
  /** Absolute canonical URL of the page. */
  readonly url: string;
  readonly name: string;
  readonly description?: string | undefined;
  /** `WebPage` by default; `CollectionPage`, `TechArticle` and the like are fine. */
  readonly type?: string | undefined;
  readonly inLanguage?: string | undefined;
  /** The site the page belongs to, written as `isPartOf`. Left out when absent. */
  readonly site?: { readonly name: string; readonly url: string } | undefined;
  /** What the page is about, written as `about`. */
  readonly about?: JsonLdEntity | undefined;
  /** More properties, written last. */
  readonly extra?: JsonLdEntity | undefined;
}

/** A schema.org page entity: `@type`, `@id`, `url`, `name`, `description`, `inLanguage`, `isPartOf`, `about`, then `extra`. */
export function webPageEntity(input: WebPageEntityInput): JsonLdEntity {
  return {
    '@type': input.type ?? 'WebPage',
    '@id': input.url,
    url: input.url,
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    inLanguage: input.inLanguage ?? 'en',
    ...(input.site ? { isPartOf: { '@type': 'WebSite', name: input.site.name, url: input.site.url } } : {}),
    ...(input.about ? { about: input.about } : {}),
    ...input.extra,
  };
}

export interface HeadTagsInput {
  /** Origin without a trailing slash, such as `https://example.test`. */
  readonly origin: string;
  /** Route of the page, such as `/guide/`. */
  readonly route: string;
  readonly title: string;
  readonly description?: string | undefined;
  /** `og:site_name`; the tag is left out when absent. */
  readonly siteName?: string | undefined;
  /** `og:title`; the page title by default. */
  readonly ogTitle?: string | undefined;
  /** `og:type`, `website` by default. */
  readonly ogType?: string | undefined;
  /** Absolute URL for `og:image`. */
  readonly image?: string | undefined;
  /** Add `<meta name="description">` too (a page template that already has one leaves this off). */
  readonly metaDescription?: boolean | undefined;
  /** `href` of the reading guide, `/llms.txt` by default; `false` leaves the `describedby` link out. */
  readonly guide?: string | false | undefined;
  /** Route of the Markdown copy; `mirrorRoute(route)` by default, `false` leaves the alternate link out. */
  readonly mirror?: string | false | undefined;
  /** One entity or a list (written as `@graph`). Left out when absent. */
  readonly jsonLd?: JsonLdEntity | readonly JsonLdEntity[] | undefined;
}

/**
 * The `<head>` tags that make a page readable by agents: canonical link, `describedby` link to the guide, alternate link to the
 * Markdown copy, Open Graph tags and a JSON-LD block, one per line. Text is escaped for attributes.
 */
export function headTags(input: HeadTagsInput): string {
  const url = `${input.origin}${input.route}`;
  const guide = input.guide === undefined ? '/llms.txt' : input.guide;
  const mirror = input.mirror === undefined ? mirrorRoute(input.route) : input.mirror;
  const lines = [
    `<link rel="canonical" href="${escapeHtml(url)}">`,
    ...(guide === false ? [] : [`<link rel="describedby" href="${escapeHtml(guide)}" type="text/plain">`]),
    ...(mirror === false ? [] : [`<link rel="alternate" type="text/markdown" href="${escapeHtml(`${input.origin}${mirror}`)}">`]),
    ...(input.metaDescription && input.description ? [`<meta name="description" content="${escapeHtml(input.description)}">`] : []),
    `<meta property="og:type" content="${escapeHtml(input.ogType ?? 'website')}">`,
    ...(input.siteName ? [`<meta property="og:site_name" content="${escapeHtml(input.siteName)}">`] : []),
    `<meta property="og:title" content="${escapeHtml(input.ogTitle ?? input.title)}">`,
    ...(input.description ? [`<meta property="og:description" content="${escapeHtml(input.description)}">`] : []),
    `<meta property="og:url" content="${escapeHtml(url)}">`,
    ...(input.image ? [`<meta property="og:image" content="${escapeHtml(input.image)}">`] : []),
    ...(input.jsonLd ? [jsonLdScript(input.jsonLd)] : []),
  ];
  return lines.join('\n');
}

/** The tag for a page that must stay out of search results (a 404, a preview). */
export const NOINDEX_TAG = '<meta name="robots" content="noindex">';

/** Put tags at the end of `<head>`. Throws when the page has no `</head>` or already has a canonical link, so a page is never decorated twice. */
export function injectHead(html: string, tags: string): string {
  if (/<link rel="canonical"/i.test(html)) throw new Error('The page already has a canonical link');
  if (!/<\/head>/i.test(html)) throw new Error('The page has no </head>');
  return html.replace(/<\/head>/i, () => `${tags}\n</head>`);
}
