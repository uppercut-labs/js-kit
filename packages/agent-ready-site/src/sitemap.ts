import { mirrorRoute, shortTitle } from './routes.js';

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** `sitemap.xml` for routes on one origin, in the order given. */
export function sitemapXml(origin: string, routes: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${routes
    .map((route) => `<url><loc>${xml(`${origin}${route}`)}</loc></url>`)
    .join('\n')}\n</urlset>\n`;
}

/** The routes of a `sitemap.xml` on `origin`, in file order. Locations on other origins are skipped. */
export function sitemapRoutes(xmlText: string, origin: string): string[] {
  const routes: string[] = [];
  for (const loc of xmlText.matchAll(/<loc>([^<]+)<\/loc>/g)) {
    const url = (loc[1] ?? '').replace(/&amp;/g, '&').trim();
    if (url === origin) routes.push('/');
    else if (url.startsWith(`${origin}/`)) routes.push(url.slice(origin.length));
  }
  return routes;
}

export interface SitemapMarkdownPage {
  readonly route: string;
  readonly title: string;
}

/** `sitemap.md`: every page in the order given, each with its Markdown copy. */
export function sitemapMarkdown(input: { readonly name: string; readonly origin: string; readonly pages: readonly SitemapMarkdownPage[] }): string {
  const { name, origin, pages } = input;
  const items = pages.map(
    (page) => `- [${shortTitle(page.title, name).replace(/([[\]])/g, '\\$1')}](${origin}${page.route}) ([md](${origin}${mirrorRoute(page.route)}))`,
  );
  return `# ${name} sitemap\n\nEvery page, in the same order as ${origin}/sitemap.xml. Each page also has a Markdown copy (the "md" link).\n\n${items.join('\n')}\n`;
}
