import { describe, expect, it } from 'vitest';
import { decodeHtml, escapeHtml, htmlToText, mirrorRoute, routeOfFile, shortTitle, textOf } from '../src/index.js';

const ORIGIN = 'https://example.test';

describe('decodeHtml and escapeHtml', () => {
  it('decodes numeric and the common named entities and leaves unknown ones', () => {
    expect(decodeHtml('a &amp; b &lt;c&gt; &#65;&#x42; &mdash; &bogus; &#xZZ;')).toBe('a & b <c> AB — &bogus; &#xZZ;');
  });

  it('leaves a code point that does not exist as written', () => {
    expect(decodeHtml('&#99999999999;')).toBe('&#99999999999;');
  });

  it('escapes the four characters that matter in text and quoted attributes', () => {
    expect(escapeHtml(`a & "b" <c>`)).toBe('a &amp; &quot;b&quot; &lt;c&gt;');
  });

  it('reads a title or cell on one line', () => {
    expect(textOf('Guilty</p><p>Gear &amp;  more\n <b>x</b>')).toBe('Guilty Gear & more x');
  });
});

describe('routes', () => {
  it('names the Markdown copy of a route', () => {
    expect(mirrorRoute('/')).toBe('/index.md');
    expect(mirrorRoute('/a/b/')).toBe('/a/b/index.md');
    expect(mirrorRoute('/a/b')).toBe('/a/b.md');
  });

  it('names the route of a built file', () => {
    expect(routeOfFile('index.html')).toBe('/');
    expect(routeOfFile('a/index.html')).toBe('/a/');
    expect(routeOfFile('a/b.html')).toBe('/a/b');
  });

  it('drops the site name from a title', () => {
    expect(shortTitle('Guide | Site', 'Site')).toBe('Guide');
    expect(shortTitle('Guide · Site', 'Site')).toBe('Guide');
    expect(shortTitle('Guide', 'Site')).toBe('Guide');
  });
});

describe('htmlToText', () => {
  const convert = (html: string, statusClass?: string) => htmlToText(html, { origin: ORIGIN, page: '/x/', statusClass });

  it('turns rendered pages into readable text with exact code and absolute links', () => {
    const text = convert(
      `<h1 class="pt"><span>Unlock &amp; play</span></h1><table class="kv"><tr><th>Status</th><td><span class="st">VERIFIED</span></td></tr></table>` +
        `<pre class="code">[Code]\npatch=1\n  indented &lt;x&gt;</pre>` +
        `<p>See <a href="../faq/">the FAQ</a> or <code>F233A433</code>.</p><button>Copy</button><label class="sr" for="q">Search</label><input id="q">` +
        `<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1|2</td><td>3</td></tr></tbody></table>` +
        `<svg role="img" aria-label="Progress chart"><text>x</text></svg><svg aria-hidden="true"></svg><img src="a.png" alt="A cat"><!-- note --><script>window.x=1</script>`,
    );
    expect(text).toMatch(/^# Unlock & play$/m);
    expect(text).toMatch(/^Status: VERIFIED$/m);
    expect(text).toContain('```\n[Code]\npatch=1\n  indented <x>\n```');
    expect(text).toContain('[the FAQ](https://example.test/faq/)');
    expect(text).toContain('`F233A433`');
    expect(text).toMatch(/^\| A \| B \|$/m);
    expect(text).toMatch(/^\| 1\\\|2 \| 3 \|$/m);
    expect(text).toContain('[Image: Progress chart]');
    expect(text).toContain('[Image: A cat]');
    expect(text).not.toMatch(/Copy|Search|<span|<svg|window|note/);
  });

  it('reads row headings with several cells as one line and skips empty cells', () => {
    const text = convert(
      `<table><tr><th scope="row">Functions</th><td>3,266 / 3,266</td><td>100.0%</td><td><div class="bar"></div></td></tr><tr><th>Files</th><td colspan="3">not tracked</td></tr></table>`,
    );
    expect(text).toBe('Functions: 3,266 / 3,266 · 100.0%\nFiles: not tracked');
  });

  it('resolves links against the page, keeps fragments and writes a bare URL once', () => {
    expect(convert('<a href="/a+/">A</a> <a href="#top">top</a> <a href="https://other.test/">https://other.test/</a><a href="b">B</a>')).toBe(
      '[A](https://example.test/a+/) [top](https://example.test/x/#top) https://other.test/ [B](https://example.test/x/b)',
    );
  });

  it('puts a space between adjacent links, bolds strong text and keeps list items on lines', () => {
    expect(convert('<ul><li><a href="/a">A</a><a href="/b">B</a></li><li><strong>bold</strong> text</li></ul>')).toBe(
      '- [A](https://example.test/a) [B](https://example.test/b)\n- **bold** text',
    );
  });

  it('reads a status chip in parentheses only when told which class it has', () => {
    const html = '<p><a href="/a">Game <span class="chip live">Matched</span></a></p>';
    expect(convert(html)).toBe('[Game Matched](https://example.test/a)');
    expect(convert(html, 'chip')).toBe('[Game (Matched)](https://example.test/a)');
  });

  it('puts a link with no text nowhere and an anchor without href as plain text', () => {
    expect(convert('<a href="/a"></a><a name="x">plain</a>')).toBe('plain');
  });

  it('reads a page of headings, a status chip, metric rows, a pipe table, a labelled image and links', () => {
    const html = `<h1>Game X</h1>
<p class="sub">2000 · PS2 <span class="chip live">All functions matched</span></p>
<section class="metrics"><table><tr><th scope="row">Functions</th><td>3,266 / 3,266 functions</td><td class="pct">100.0%</td><td class="mb"><div class="bar"><i style="width:100.00%"></i></div></td></tr><tr><th scope="row">Source files</th><td colspan="3" class="na">not tracked yet</td></tr></table></section>
<table><tr><th>Game</th><th>Year</th></tr><tr><td>X</td><td>2000</td></tr></table>
<figure><div class="svgwrap"><svg role="img" aria-label="The climb"><path d="M0 0"/></svg></div></figure>
<p><a href="/x+/">X Plus</a> and <a href="#status">status</a></p>`;
    expect(htmlToText(html, { origin: ORIGIN, page: '/x/', statusClass: 'chip' })).toBe(`# Game X

2000 · PS2 (All functions matched)

Functions: 3,266 / 3,266 functions · 100.0%
Source files: not tracked yet

| Game | Year |
| --- | --- |
| X | 2000 |

[Image: The climb]

[X Plus](https://example.test/x+/) and [status](https://example.test/x/#status)`);
  });
});
