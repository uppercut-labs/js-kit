/** Small HTML helpers and the HTML-to-Markdown-style text converter used for the Markdown mirrors and the plain-text files. */

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  raquo: '»',
  laquo: '«',
  middot: '·',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  rarr: '→',
  larr: '←',
  times: '×',
  copy: '©',
};

/** Decode numeric entities and the named entities in the table above; anything else is left as written. */
export function decodeHtml(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole: string, name: string): string => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      try {
        return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
      } catch {
        return whole;
      }
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/** Escape text for an HTML text node or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

// Block tags inside a link or cell separate words ("Name</p><p>1998"); inline tags do not.
function oneLine(html: string): string {
  return decodeHtml(
    stripTags(html.replace(/<\/?(p|div|h[1-6]|li|ul|ol|section|article|header|footer|figure|figcaption|br|tr|td|th|b|strong|small)\b[^>]*>/gi, ' ')),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text of a title or a cell on one line: block tags read as spaces, entities are decoded, runs of white space collapse. */
export function textOf(html: string): string {
  return oneLine(html);
}

function absoluteUrl(href: string, origin: string, page: string): string {
  if (/^[a-z]+:/i.test(href)) return href;
  if (href.startsWith('#')) return `${origin}${page}${href}`;
  return new URL(href, `${origin}${page}`).href;
}

// Rows that start with a row heading read as "Heading: cell · cell" lines; anything else becomes a
// pipe table headed by its first row. Empty cells (a bar drawn with CSS) are left out of heading rows.
function tableToText(html: string): string {
  const rows: string[][] = [];
  let hasRowHeadings = true;
  for (const row of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells: string[] = [];
    const cellTags: string[] = [];
    for (const cell of (row[1] ?? '').matchAll(/<(th|td)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      cellTags.push((cell[1] ?? '').toLowerCase());
      cells.push(oneLine(cell[2] ?? '').replace(/\|/g, '\\|'));
    }
    if (!cells.length) continue;
    if (cellTags.length < 2 || cellTags[0] !== 'th' || cellTags.slice(1).includes('th')) hasRowHeadings = false;
    rows.push(cells);
  }
  if (!rows.length) return '';
  if (hasRowHeadings) return `\n\n${rows.map((row) => `${row[0] ?? ''}: ${row.slice(1).filter(Boolean).join(' · ')}`).join('\n')}\n\n`;
  const width = Math.max(...rows.map((row) => row.length));
  const pipeRow = (row: string[]): string => `| ${Array.from({ length: width }, (_: unknown, index: number) => row[index] ?? '').join(' | ')} |`;
  return `\n\n${[pipeRow(rows[0] ?? []), `|${' --- |'.repeat(width)}`, ...rows.slice(1).map(pipeRow)].join('\n')}\n\n`;
}

export interface HtmlToTextOptions {
  /** Origin that relative links are resolved against, such as `https://example.test`. */
  readonly origin: string;
  /** Route of the page the HTML came from, such as `/guide/`; relative links resolve against it. */
  readonly page: string;
  /** A `<span class="NAME ...">label</span>` with this class reads as ` (label) `. Off by default. */
  readonly statusClass?: string | undefined;
}

/**
 * Convert the HTML a static renderer emits (headings, prose, lists, tables, code, links, labelled images and SVG)
 * into Markdown-style text. Scripts, styles, buttons, form controls and their labels are dropped, code keeps its exact
 * white space, and links become absolute `[text](url)`.
 */
export function htmlToText(html: string, options: HtmlToTextOptions): string {
  const { origin, page } = options;
  const heldBlocks: string[] = [];
  const holdBlock = (block: string): string => {
    heldBlocks.push(block);
    return `\u0000${heldBlocks.length - 1}\u0000`;
  };
  const release = (value: string): string => value.replace(/\u0000(\d+)\u0000/g, (_match: string, index: string): string => heldBlocks[Number(index)] ?? '');
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|template|button|select|textarea)\b[\s\S]*?<\/\1>/gi, '')
    // Labels for removed form controls ("Filter codes") are not page content.
    .replace(/<label\b[^>]*\bfor="[^"]*"[^>]*>[\s\S]*?<\/label>/gi, '');
  if (options.statusClass) {
    // A status chip is a label beside its text, so it reads in parentheses (square brackets would break a link label).
    const name = options.statusClass.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    text = text.replace(new RegExp(`<span class="${name}\\b[^"]*">([^<]*)</span>`, 'gi'), (_: string, status: string): string => ` (${status}) `);
  }
  text = text
    .replace(/<\/span>/gi, '</span> ')
    .replace(/<svg\b([^>]*)>[\s\S]*?<\/svg>/gi, (_: string, attrs: string): string => {
      const label = /aria-label="([^"]*)"/i.exec(attrs)?.[1];
      return label && !/aria-hidden="true"/i.test(attrs) ? ` [Image: ${decodeHtml(label)}] ` : '';
    })
    .replace(/<(input|img)\b[^>]*>/gi, (tag: string): string => {
      const alt = /\balt="([^"]+)"/i.exec(tag)?.[1];
      return alt ? ` [Image: ${decodeHtml(alt)}] ` : '';
    })
    .replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_: string, body: string): string =>
      holdBlock(`\n\n\`\`\`\n${decodeHtml(stripTags(body)).replace(/\n+$/, '')}\n\`\`\`\n\n`),
    )
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_: string, body: string): string => {
      const code = oneLine(body);
      return code ? holdBlock(`\`${code}\``) : '';
    })
    .replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_: string, attrs: string, body: string): string => {
      const linkText = oneLine(release(body));
      const href = /\bhref="([^"]*)"/i.exec(attrs)?.[1];
      if (!linkText) return '';
      if (!href) return linkText;
      const url = absoluteUrl(decodeHtml(href), origin, page);
      return holdBlock(url === linkText ? url : `[${linkText}](${url})`);
    })
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_: string, _tag: string, body: string): string => {
      const bold = body.trim();
      return bold ? `**${bold}**` : '';
    })
    .replace(/<table\b[^>]*>[\s\S]*?<\/table>/gi, (whole: string): string => holdBlock(tableToText(release(whole))))
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_: string, level: string, body: string): string => `\n\n${'#'.repeat(Number(level))} ${oneLine(body)}\n\n`)
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<summary\b[^>]*>([\s\S]*?)<\/summary>/gi, (_: string, body: string): string => `\n\n**${oneLine(body)}**\n\n`)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|section|article|aside|header|footer|nav|figure|figcaption|details|ul|ol|dl|dt|dd|main|blockquote|form)\b[^>]*>/gi, '\n\n');
  // Adjacent links ("[A](a)[B](b)") read as one run of text without a separator.
  text = text.replace(/(\u0000\d+\u0000)(?=\u0000\d+\u0000)/g, (held: string): string => `${held} `);
  text = decodeHtml(stripTags(text));
  text = text
    .split('\n')
    .map((line) => line.replace(/[ \t\u00a0]+/g, ' ').trim())
    .join('\n')
    .replace(/^- *$/gm, '')
    .replace(/\n{3,}/g, '\n\n');
  // Restore held blocks last so code keeps its exact white space.
  for (let index = heldBlocks.length - 1; index >= 0; index--) text = text.split(`\u0000${index}\u0000`).join(heldBlocks[index] ?? '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
