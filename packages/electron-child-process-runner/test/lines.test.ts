import { describe, expect, it } from 'vitest';
import { createLineReader, startProcess } from '../src/index.js';
import type { LineReaderOptions } from '../src/index.js';

function reader(options: Partial<LineReaderOptions> = {}) {
  const lines: string[] = [];
  const overflows: string[] = [];
  const r = createLineReader({ maxLineBytes: 64, maxTotalBytes: 10_000, onLine: (line) => lines.push(line), onOverflow: (kind) => overflows.push(kind), ...options });
  return { r, lines, overflows };
}

describe('createLineReader', () => {
  it('splits wherever the chunks fall, inside a multi-byte character too, and drops a trailing CR', () => {
    const { r, lines } = reader();
    const bytes = Buffer.from('{"a":"東京"}\n{"b":2}\r\n{"c":3}\n', 'utf8');
    for (let i = 0; i < bytes.length; i++) r.push(bytes.subarray(i, i + 1));
    expect(lines).toEqual(['{"a":"東京"}', '{"b":2}', '{"c":3}']);
    expect(r.end().leftover).toBe(0);
    expect(r.stats.lines).toBe(3);
  });

  it('drops a line over the cap, reports it once, and delivers the next line', () => {
    const { r, lines, overflows } = reader();
    r.push(Buffer.from(`short\n${'x'.repeat(50)}`));
    r.push(Buffer.from('y'.repeat(500)));
    r.push(Buffer.from('z'.repeat(500)));
    r.push(Buffer.from('\nafter\n'));
    expect(lines).toEqual(['short', 'after']);
    expect(overflows).toEqual(['line']);
    expect(r.stats.maxHeld).toBeLessThanOrEqual(64);
    expect(r.stats.longLines).toBe(1);
  });

  it('passes a line exactly at the cap and drops one a byte longer', () => {
    const a = reader();
    a.r.push(Buffer.from(`${'x'.repeat(64)}\n`));
    expect(a.lines).toHaveLength(1);
    const b = reader();
    b.r.push(Buffer.from(`${'x'.repeat(65)}\nok\n`));
    expect(b.lines).toEqual(['ok']);
    expect(b.overflows).toEqual(['line']);
  });

  it('stops delivering after the total cap but still accepts data, holding nothing', () => {
    const { r, lines, overflows } = reader({ maxTotalBytes: 100 });
    for (let i = 0; i < 1000; i++) r.push(Buffer.from(`line ${i}\n`));
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.length).toBeLessThan(20);
    expect(overflows).toEqual(['total']);
    expect(r.stats.bytesSeen).toBeGreaterThan(5000);
    expect(r.end().leftover).toBe(0);
  });

  it('counts an unfinished last line without delivering it, and stops on request', () => {
    const { r, lines } = reader();
    r.push(Buffer.from('whole\nhalf'));
    expect(lines).toEqual(['whole']);
    expect(r.end().leftover).toBe(4);
    r.stop();
    r.push(Buffer.from('later\n'));
    expect(lines).toEqual(['whole']);
  });

  it('reads a real child through startProcess', async () => {
    const lines: string[] = [];
    const r = createLineReader({ maxLineBytes: 1024, maxTotalBytes: 1 << 20, onLine: (l) => lines.push(l), onOverflow: () => {} });
    const run = startProcess({ command: process.execPath, args: ['-e', "for (let i = 0; i < 3; i++) process.stdout.write(JSON.stringify({ seq: i }) + '\\n')"], onStdout: (c) => r.push(c) });
    await run.done;
    expect(lines.map((l) => (JSON.parse(l) as { seq: number }).seq)).toEqual([0, 1, 2]);
  });
});
