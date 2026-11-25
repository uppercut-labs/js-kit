import { describe, expect, it } from 'vitest';
import { agentHeadersFile, robotsTxt, sitemapXml } from '../src/index.js';

// The strings below are what static sites wrote by hand before this package, with a synthetic origin.
const ORIGIN = 'https://example.test';

describe('hand-written files this package replaces', () => {
  it('robots.txt that allows everything and names the sitemap', () => {
    const reference = `User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml\n`;
    expect(robotsTxt({ sitemaps: [`${ORIGIN}/sitemap.xml`] })).toBe(reference);
  });

  it('sitemap.xml from a list of routes', () => {
    const urls = ['/', '/a/', '/b/c/'];
    const reference = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
      .map((url) => `<url><loc>${ORIGIN}${url}</loc></url>`)
      .join('\n')}\n</urlset>\n`;
    expect(sitemapXml(ORIGIN, urls)).toBe(reference);
  });

  it('_headers with the guide link, the usual response headers and the home page copy', () => {
    const reference = `/*\n  Link: </llms.txt>; rel="describedby"; type="text/plain"\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: strict-origin-when-cross-origin\n  X-Frame-Options: DENY\n/\n  Link: </index.md>; rel="alternate"; type="text/markdown"\n`;
    // buildHeadersFile puts a blank line between rules; Cloudflare Pages reads both forms the same way.
    expect(agentHeadersFile({ headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY' } })).toBe(
      reference.replace('\n/\n', '\n\n/\n'),
    );
  });
});
