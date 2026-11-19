import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ICNS_PNG_TYPES, packIcns, packIco } from './containers.js';
import {
  renderMaskable,
  renderOpaque,
  renderPng,
  renderRound,
  renderScaled,
  type IconSource,
  type RenderOptions,
} from './render.js';

export type IconTarget = 'pwa' | 'apple-touch' | 'favicon' | 'android' | 'ico' | 'icns' | 'linux';

export const ALL_TARGETS: readonly IconTarget[] = ['pwa', 'apple-touch', 'favicon', 'android', 'ico', 'icns', 'linux'];

export interface WebManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: 'any' | 'maskable';
}

export interface GenerateOptions extends RenderOptions {
  /** Folder the files are written to. */
  outDir: string;
  /** Which sets to build. Default: all of them. */
  targets?: readonly IconTarget[];
  /** Margin on each side of maskable icons, as a fraction. Default 0.1. */
  maskableInset?: number;
  /** Background of maskable and apple-touch icons. Default `#ffffff`. */
  maskableBackground?: string;
  /** Share of the canvas the artwork fills in the ICNS file. Default 824/1024, Apple's icon grid. */
  macArtScale?: number;
  /** Pixel sizes in the ICO file. Default 16, 20, 24, 32, 40, 48, 64, 128, 256. */
  icoSizes?: readonly number[];
  /** Pixel sizes of the Linux PNG set. Default 16, 24, 32, 48, 64, 128, 256, 512. */
  linuxSizes?: readonly number[];
  /** Square sizes of the PWA icons. Default 192 and 512. */
  pwaSizes?: readonly number[];
  /** Also write `icons.manifest.json` containing the web manifest icons array. */
  manifest?: boolean;
  /** URL prefix put in front of file names in the manifest icons. Default `/icons/`. */
  manifestBase?: string;
}

export interface GenerateResult {
  /** Every file written, as paths relative to `outDir`, using forward slashes. */
  files: string[];
  /** Web manifest `icons` entries for the pwa target. Empty when pwa was not built. */
  manifestIcons: WebManifestIcon[];
}

const DEFAULT_ICO = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const DEFAULT_LINUX = [16, 24, 32, 48, 64, 128, 256, 512];
const ANDROID: ReadonlyArray<readonly [density: string, size: number]> = [
  ['mdpi', 48],
  ['hdpi', 72],
  ['xhdpi', 96],
  ['xxhdpi', 144],
  ['xxxhdpi', 192],
];

/** Builds the manifest `icons` array for the given PWA sizes. */
export function webManifestIcons(sizes: readonly number[] = [192, 512], base = '/icons/'): WebManifestIcon[] {
  const prefix = base.endsWith('/') ? base : `${base}/`;
  return sizes.flatMap((size) => [
    { src: `${prefix}icon-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'any' as const },
    { src: `${prefix}icon-maskable-${size}.png`, sizes: `${size}x${size}`, type: 'image/png', purpose: 'maskable' as const },
  ]);
}

/** Builds the icon sets named in `targets` from one source image and writes them under `outDir`. */
export async function generate(source: IconSource, options: GenerateOptions): Promise<GenerateResult> {
  const {
    outDir,
    targets = ALL_TARGETS,
    maskableInset = 0.1,
    maskableBackground = '#ffffff',
    macArtScale = 824 / 1024,
    icoSizes = DEFAULT_ICO,
    linuxSizes = DEFAULT_LINUX,
    pwaSizes = [192, 512],
    manifest = false,
    manifestBase = '/icons/',
  } = options;
  const render: RenderOptions = { fit: options.fit, background: options.background };
  for (const target of targets) {
    if (!ALL_TARGETS.includes(target)) throw new Error(`unknown target "${target}"; use one of ${ALL_TARGETS.join(', ')}`);
  }
  const want = new Set(targets);
  const files: string[] = [];
  const write = async (name: string, data: Uint8Array | string): Promise<void> => {
    const full = path.join(outDir, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, data);
    files.push(name);
  };
  // Each size is rendered once and reused across targets.
  const cache = new Map<number, Promise<Buffer>>();
  const plain = (size: number): Promise<Buffer> => {
    let hit = cache.get(size);
    if (!hit) cache.set(size, (hit = renderPng(source, size, render)));
    return hit;
  };

  let manifestIcons: WebManifestIcon[] = [];
  if (want.has('pwa')) {
    for (const size of pwaSizes) {
      await write(`icon-${size}.png`, await plain(size));
      await write(
        `icon-maskable-${size}.png`,
        await renderMaskable(source, size, { ...render, inset: maskableInset, background: maskableBackground }),
      );
    }
    manifestIcons = webManifestIcons(pwaSizes, manifestBase);
    if (manifest) await write('icons.manifest.json', `${JSON.stringify(manifestIcons, null, 2)}\n`);
  }
  if (want.has('apple-touch')) {
    await write('apple-touch-icon.png', await renderOpaque(source, 180, { ...render, background: maskableBackground }));
  }
  if (want.has('favicon')) {
    const frames = await Promise.all([16, 32, 48].map(async (size) => ({ size, data: await plain(size) })));
    await write('favicon.ico', packIco(frames));
    await write('favicon.png', await plain(32));
  }
  if (want.has('android')) {
    for (const [density, size] of ANDROID) {
      await write(`mipmap-${density}/ic_launcher.png`, await plain(size));
      await write(`mipmap-${density}/ic_launcher_round.png`, await renderRound(source, size, render));
    }
  }
  if (want.has('ico')) {
    const frames = await Promise.all(icoSizes.map(async (size) => ({ size, data: await plain(size) })));
    await write('icon.ico', packIco(frames));
  }
  if (want.has('icns')) {
    const sizes = [...new Set(ICNS_PNG_TYPES.map(([, size]) => size))];
    const rendered = new Map(
      await Promise.all(sizes.map(async (size) => [size, await renderScaled(source, size, macArtScale, render)] as const)),
    );
    await write('icon.icns', packIcns(ICNS_PNG_TYPES.map(([type, size]) => ({ type, data: rendered.get(size)! }))));
  }
  if (want.has('linux')) {
    for (const size of linuxSizes) await write(`linux/${size}x${size}.png`, await plain(size));
  }
  return { files, manifestIcons };
}
