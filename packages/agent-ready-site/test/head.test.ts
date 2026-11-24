import { describe, expect, it } from 'vitest';
import { headTags, injectHead, jsonLdScript, NOINDEX_TAG, webPageEntity } from '../src/index.js';

const ORIGIN = 'https://example.test';

function ld(html: string): Record<string, unknown> {
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (block === undefined) throw new Error('no JSON-LD block');
  return JSON.parse(block) as Record<string, unknown>;
}

describe('jsonLdScript', () => {
  it('cannot be closed early by its data', () => {
    const html = jsonLdScript({ '@type': 'WebPage', name: 'A </script><b>&' });
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(ld(html)['name']).toBe('A </script><b>&');
  });

  it('adds @context to one entity and writes a list as @graph', () => {
    expect(ld(jsonLdScript({ '@type': 'WebPage' }))).toEqual({ '@context': 'https://schema.org', '@type': 'WebPage' });
    expect(ld(jsonLdScript([{ '@type': 'WebPage' }, { '@type': 'Dataset' }]))).toEqual({
      '@context': 'https://schema.org',
      '@graph': [{ '@type': 'WebPage' }, { '@type': 'Dataset' }],
    });
  });

  it('keeps an @context the entity has', () => {
    expect(ld(jsonLdScript({ '@context': 'https://example.test/ctx', '@type': 'X' }))['@context']).toBe('https://example.test/ctx');
  });
});

describe('webPageEntity', () => {
  it('writes the page, its site and what it is about in a fixed order', () => {
    const entity = webPageEntity({
      url: `${ORIGIN}/a/`,
      name: 'A',
      description: 'About A',
      type: 'CollectionPage',
      site: { name: 'Site', url: `${ORIGIN}/` },
      about: { '@type': 'VideoGame', name: 'Game' },
      extra: { dateModified: '2026-01-02' },
    });
    expect(Object.keys(entity)).toEqual(['@type', '@id', 'url', 'name', 'description', 'inLanguage', 'isPartOf', 'about', 'dateModified']);
    expect(entity['@type']).toBe('CollectionPage');
    expect(entity['isPartOf']).toEqual({ '@type': 'WebSite', name: 'Site', url: `${ORIGIN}/` });
  });

  it('leaves out what is absent', () => {
    expect(Object.keys(webPageEntity({ url: `${ORIGIN}/`, name: 'Home' }))).toEqual(['@type', '@id', 'url', 'name', 'inLanguage']);
  });
});

describe('headTags', () => {
  it('writes one canonical, the guide link, the Markdown alternate, Open Graph tags and JSON-LD', () => {
    const html = headTags({
      origin: ORIGIN,
      route: '/a/b/',
      title: 'A "quoted" <title>',
      description: 'About & more',
      siteName: 'Site',
      jsonLd: webPageEntity({ url: `${ORIGIN}/a/b/`, name: 'A' }),
    });
    expect(html.split('\n')).toEqual([
      '<link rel="canonical" href="https://example.test/a/b/">',
      '<link rel="describedby" href="/llms.txt" type="text/plain">',
      '<link rel="alternate" type="text/markdown" href="https://example.test/a/b/index.md">',
      '<meta property="og:type" content="website">',
      '<meta property="og:site_name" content="Site">',
      '<meta property="og:title" content="A &quot;quoted&quot; &lt;title&gt;">',
      '<meta property="og:description" content="About &amp; more">',
      '<meta property="og:url" content="https://example.test/a/b/">',
      expect.stringMatching(/^<script type="application\/ld\+json">/),
    ]);
    expect(ld(html)['@id']).toBe(`${ORIGIN}/a/b/`);
  });

  it('can add the meta description and an image, change og values and drop the guide and mirror links', () => {
    const html = headTags({
      origin: ORIGIN,
      route: '/guide',
      title: 'Guide',
      ogTitle: 'Guide | Site',
      ogType: 'article',
      description: 'D',
      metaDescription: true,
      image: `${ORIGIN}/logo.png`,
      guide: `${ORIGIN}/llms.txt`,
      mirror: false,
    });
    expect(html).toContain('<meta name="description" content="D">');
    expect(html).toContain('<meta property="og:type" content="article">');
    expect(html).toContain('<meta property="og:title" content="Guide | Site">');
    expect(html).toContain('<meta property="og:image" content="https://example.test/logo.png">');
    expect(html).toContain('<link rel="describedby" href="https://example.test/llms.txt" type="text/plain">');
    expect(html).not.toContain('text/markdown');
    expect(headTags({ origin: ORIGIN, route: '/', title: 'T', guide: false })).not.toContain('describedby');
    expect(headTags({ origin: ORIGIN, route: '/', title: 'T' })).toContain('href="https://example.test/index.md"');
  });
});

describe('injectHead', () => {
  it('puts tags before </head>, once', () => {
    const page = '<html><head><title>T</title></head><body></body></html>';
    const out = injectHead(page, '<link rel="canonical" href="https://example.test/">');
    expect(out).toBe('<html><head><title>T</title><link rel="canonical" href="https://example.test/">\n</head><body></body></html>');
    expect(() => injectHead(out, 'x')).toThrow(/canonical/);
    expect(() => injectHead('<p>no head</p>', 'x')).toThrow(/no <\/head>/);
  });

  it('inserts text that holds $ patterns as written', () => {
    expect(injectHead('<head></head>', '<meta content="$&$1">')).toContain('<meta content="$&$1">');
  });

  it('exports the noindex tag', () => {
    expect(NOINDEX_TAG).toBe('<meta name="robots" content="noindex">');
  });
});
