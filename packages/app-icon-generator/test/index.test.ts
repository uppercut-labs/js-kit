import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALL_TARGETS,
  generate,
  packIcns,
  packIco,
  renderMaskable,
  renderOpaque,
  renderPng,
  renderRound,
  renderScaled,
  runCli,
  webManifestIcons,
} from '../src/index.js';

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 120x80 test image: solid red with a blue square in the middle. */
async function testImage(): Promise<Buffer> {
  const blue = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#0000ff' } }).png().toBuffer();
  return sharp({ create: { width: 120, height: 80, channels: 3, background: '#ff0000' } })
    .composite([{ input: blue, left: 50, top: 30 }])
    .png()
    .toBuffer();
}

const SVG = Buffer.from(
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#00ff00"/></svg>',
);

async function pixel(png: Uint8Array, x: number, y: number): Promise<number[]> {
  const { data, info } = await sharp(Buffer.from(png)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

async function size(png: Uint8Array): Promise<[number, number]> {
  const meta = await sharp(Buffer.from(png)).metadata();
  return [meta.width!, meta.height!];
}

describe('renderPng', () => {
  it('returns a PNG of the requested square size from a non-square source', async () => {
    const out = await renderPng(await testImage(), 48);
    expect([...out.subarray(0, 8)]).toEqual(PNG_MAGIC);
    expect(await size(out)).toEqual([48, 48]);
  });

  it('crops with cover and keeps the centre', async () => {
    const out = await renderPng(await testImage(), 80);
    expect(await pixel(out, 40, 40)).toEqual([0, 0, 255, 255]);
    expect(await pixel(out, 2, 2)).toEqual([255, 0, 0, 255]);
  });

  it('shows the whole image with contain and leaves the background transparent', async () => {
    const out = await renderPng(await testImage(), 120, { fit: 'contain' });
    expect((await pixel(out, 60, 2))[3]).toBe(0);
    expect(await pixel(out, 30, 60)).toEqual([255, 0, 0, 255]);
  });

  it('fills contain gaps with the given background', async () => {
    const out = await renderPng(await testImage(), 120, { fit: 'contain', background: '#00ff00' });
    expect(await pixel(out, 60, 2)).toEqual([0, 255, 0, 255]);
  });

  it('renders SVG at the target size', async () => {
    const out = await renderPng(SVG, 256);
    expect(await size(out)).toEqual([256, 256]);
    expect(await pixel(out, 128, 128)).toEqual([0, 255, 0, 255]);
  });

  it('reads a path on disk', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'aig-'));
    try {
      const file = path.join(dir, 'in.png');
      await writeFile(file, await testImage());
      expect(await size(await renderPng(file, 20))).toEqual([20, 20]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid sizes', async () => {
    const img = await testImage();
    await expect(renderPng(img, 0)).rejects.toThrow(RangeError);
    await expect(renderPng(img, 1.5)).rejects.toThrow(RangeError);
  });

  it('rejects an unreadable source', async () => {
    await expect(renderPng(Buffer.from('not an image'), 16)).rejects.toThrow();
  });
});

describe('renderMaskable', () => {
  it('is opaque, with the background in the margin and the art inside', async () => {
    const out = await renderMaskable(await testImage(), 100, { background: '#112233' });
    expect(await size(out)).toEqual([100, 100]);
    expect(await pixel(out, 2, 2)).toEqual([0x11, 0x22, 0x33, 255]);
    expect(await pixel(out, 50, 50)).toEqual([0, 0, 255, 255]);
  });

  it('honours the inset', async () => {
    const img = await testImage();
    const small = await renderMaskable(img, 100, { inset: 0.3, background: '#000000' });
    // 25px from the edge is inside the margin at 0.3 but inside the art at 0.1
    expect(await pixel(small, 25, 50)).toEqual([0, 0, 0, 255]);
    const big = await renderMaskable(img, 100, { inset: 0.1, background: '#000000' });
    expect(await pixel(big, 25, 25)).toEqual([255, 0, 0, 255]);
  });

  it('rejects an inset outside 0 to 0.45', async () => {
    const img = await testImage();
    await expect(renderMaskable(img, 64, { inset: 0.6 })).rejects.toThrow(RangeError);
    await expect(renderMaskable(img, 64, { inset: -0.1 })).rejects.toThrow(RangeError);
  });
});

describe('renderScaled, renderRound and renderOpaque', () => {
  it('scales the art and leaves a transparent margin', async () => {
    const out = await renderScaled(await testImage(), 100, 0.8);
    expect(await size(out)).toEqual([100, 100]);
    expect((await pixel(out, 2, 2))[3]).toBe(0);
    expect(await pixel(out, 50, 50)).toEqual([0, 0, 255, 255]);
  });

  it('rejects a scale outside 0 to 1', async () => {
    await expect(renderScaled(await testImage(), 64, 1.2)).rejects.toThrow(RangeError);
    await expect(renderScaled(await testImage(), 64, 0)).rejects.toThrow(RangeError);
  });

  it('cuts the corners of a round icon', async () => {
    const out = await renderRound(await testImage(), 64);
    expect((await pixel(out, 0, 0))[3]).toBe(0);
    expect((await pixel(out, 32, 32))[3]).toBe(255);
  });

  it('flattens transparency onto the background', async () => {
    const out = await renderOpaque(SVG, 32, { fit: 'contain', background: '#ff00ff' });
    expect(await pixel(out, 16, 16)).toEqual([0, 255, 0, 255]);
    const wide = await renderOpaque(await testImage(), 60, { fit: 'contain', background: '#ff00ff' });
    expect(await pixel(wide, 30, 1)).toEqual([255, 0, 255, 255]);
  });
});

describe('packIco', () => {
  it('writes the header, directory entries and frame data', () => {
    const a = Buffer.from('aaaa');
    const b = Buffer.from('bbbbbb');
    const ico = packIco([
      { size: 16, data: a },
      { size: 256, data: b },
    ]);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);
    expect(ico[6]).toBe(16);
    expect(ico[7]).toBe(16);
    expect(ico.readUInt32LE(6 + 8)).toBe(4);
    expect(ico.readUInt32LE(6 + 12)).toBe(6 + 32);
    expect(ico[6 + 16]).toBe(0); // 256 is stored as 0
    expect(ico.readUInt32LE(6 + 16 + 8)).toBe(6);
    expect(ico.readUInt32LE(6 + 16 + 12)).toBe(6 + 32 + 4);
    expect(ico.subarray(6 + 32).toString()).toBe('aaaabbbbbb');
  });

  it('rejects empty input and bad sizes', () => {
    expect(() => packIco([])).toThrow(RangeError);
    expect(() => packIco([{ size: 0, data: Buffer.alloc(1) }])).toThrow(RangeError);
    expect(() => packIco([{ size: 257, data: Buffer.alloc(1) }])).toThrow(RangeError);
  });
});

describe('packIcns', () => {
  it('writes the magic, total length and chunks big-endian', () => {
    const icns = packIcns([
      { type: 'ic07', data: Buffer.from('xy') },
      { type: 'ic08', data: Buffer.from('z') },
    ]);
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.subarray(8, 12).toString('ascii')).toBe('ic07');
    expect(icns.readUInt32BE(12)).toBe(10);
    expect(icns.subarray(16, 18).toString()).toBe('xy');
    expect(icns.subarray(18, 22).toString('ascii')).toBe('ic08');
    expect(icns.readUInt32BE(22)).toBe(9);
  });

  it('rejects empty input and bad type codes', () => {
    expect(() => packIcns([])).toThrow(RangeError);
    expect(() => packIcns([{ type: 'abc', data: Buffer.alloc(1) }])).toThrow(RangeError);
  });
});

describe('webManifestIcons', () => {
  it('lists any and maskable entries for each size', () => {
    expect(webManifestIcons([192], 'assets')).toEqual([
      { src: 'assets/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'assets/icon-maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
    ]);
  });

  it('defaults to 192 and 512 under /icons/', () => {
    const icons = webManifestIcons();
    expect(icons.map((i) => i.src)).toEqual([
      '/icons/icon-192.png',
      '/icons/icon-maskable-192.png',
      '/icons/icon-512.png',
      '/icons/icon-maskable-512.png',
    ]);
  });
});

describe('generate', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aig-out-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes every target by default with correct sizes and headers', async () => {
    const result = await generate(await testImage(), { outDir: dir });
    for (const file of result.files) await readFile(path.join(dir, file));

    expect(await size(await readFile(path.join(dir, 'icon-192.png')))).toEqual([192, 192]);
    expect(await size(await readFile(path.join(dir, 'icon-maskable-512.png')))).toEqual([512, 512]);
    expect(await size(await readFile(path.join(dir, 'apple-touch-icon.png')))).toEqual([180, 180]);
    expect(await size(await readFile(path.join(dir, 'mipmap-xhdpi/ic_launcher_round.png')))).toEqual([96, 96]);
    expect(await size(await readFile(path.join(dir, 'linux/256x256.png')))).toEqual([256, 256]);

    const ico = await readFile(path.join(dir, 'icon.ico'));
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(9);
    const firstOffset = ico.readUInt32LE(6 + 12);
    expect([...ico.subarray(firstOffset, firstOffset + 8)]).toEqual(PNG_MAGIC);

    const favicon = await readFile(path.join(dir, 'favicon.ico'));
    expect(favicon.readUInt16LE(4)).toBe(3);

    const icns = await readFile(path.join(dir, 'icon.icns'));
    expect(icns.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(icns.readUInt32BE(4)).toBe(icns.length);
    expect(icns.subarray(8, 12).toString('ascii')).toBe('icp4');
    expect([...icns.subarray(16, 24)]).toEqual(PNG_MAGIC);
    expect(result.manifestIcons).toHaveLength(4);
  });

  it('builds only the requested targets', async () => {
    const result = await generate(SVG, { outDir: dir, targets: ['ico'] });
    expect(result.files).toEqual(['icon.ico']);
    expect(await readdir(dir)).toEqual(['icon.ico']);
    expect(result.manifestIcons).toEqual([]);
  });

  it('honours custom ICO, Linux and PWA sizes', async () => {
    await generate(SVG, {
      outDir: dir,
      targets: ['ico', 'linux', 'pwa'],
      icoSizes: [16, 32],
      linuxSizes: [22],
      pwaSizes: [144],
    });
    expect((await readFile(path.join(dir, 'icon.ico'))).readUInt16LE(4)).toBe(2);
    expect(await readdir(path.join(dir, 'linux'))).toEqual(['22x22.png']);
    expect(await size(await readFile(path.join(dir, 'icon-144.png')))).toEqual([144, 144]);
  });

  it('writes the manifest icons file when asked', async () => {
    const result = await generate(SVG, { outDir: dir, targets: ['pwa'], manifest: true, manifestBase: '/img/' });
    const written = JSON.parse(await readFile(path.join(dir, 'icons.manifest.json'), 'utf8'));
    expect(written).toEqual(result.manifestIcons);
    expect(written[0].src).toBe('/img/icon-192.png');
  });

  it('applies the maskable inset and background', async () => {
    await generate(await testImage(), {
      outDir: dir,
      targets: ['pwa'],
      pwaSizes: [100],
      maskableInset: 0.2,
      maskableBackground: '#102030',
    });
    const maskable = await readFile(path.join(dir, 'icon-maskable-100.png'));
    expect(await pixel(maskable, 5, 5)).toEqual([0x10, 0x20, 0x30, 255]);
  });

  it('rejects an unknown target and writes nothing', async () => {
    await expect(generate(SVG, { outDir: dir, targets: ['pwa', 'tv' as never] })).rejects.toThrow(/unknown target "tv"/);
    expect(await readdir(dir)).toEqual([]);
  });

  it('lists every target in ALL_TARGETS', () => {
    expect([...ALL_TARGETS].sort()).toEqual(['android', 'apple-touch', 'favicon', 'icns', 'ico', 'linux', 'pwa']);
  });
});

describe('runCli', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'aig-cli-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(args, (l) => out.push(l), (l) => err.push(l));
    return { code, out, err };
  }

  it('generates the chosen targets from a source file', async () => {
    const src = path.join(dir, 'in.png');
    await writeFile(src, await testImage());
    const { code, out } = await run([src, '--out', path.join(dir, 'o'), '--targets', 'ico,pwa', '--manifest']);
    expect(code).toBe(0);
    expect(out).toContain('icon.ico');
    expect(out).toContain('icons.manifest.json');
    expect(out.at(-1)).toMatch(/^\d+ files written to /);
    expect((await readFile(path.join(dir, 'o', 'icon.ico'))).readUInt16LE(2)).toBe(1);
  });

  it('prints help and exits 0', async () => {
    const { code, out } = await run(['--help']);
    expect(code).toBe(0);
    expect(out[0]).toContain('Usage: app-icon-generator');
  });

  it('exits 2 when the source or --out is missing', async () => {
    expect((await run(['--out', dir])).code).toBe(2);
    expect((await run(['in.png'])).code).toBe(2);
  });

  it('exits 2 on unknown options and bad values', async () => {
    expect((await run(['in.png', '--out', dir, '--bogus'])).code).toBe(2);
    expect((await run(['in.png', '--out', dir, '--fit', 'stretch'])).code).toBe(2);
  });

  it('exits 1 with a message for a bad number, bad target or missing file', async () => {
    const bad = await run(['in.png', '--out', dir, '--maskable-inset', 'abc']);
    expect(bad.code).toBe(1);
    expect(bad.err[0]).toContain('--maskable-inset');
    const target = await run([path.join(dir, 'x.png'), '--out', dir, '--targets', 'tv']);
    expect(target.code).toBe(1);
    const missing = await run([path.join(dir, 'nope.png'), '--out', dir, '--targets', 'ico']);
    expect(missing.code).toBe(1);
  });
});
