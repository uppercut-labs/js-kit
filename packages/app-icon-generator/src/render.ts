import sharp, { type Sharp } from 'sharp';

/** A path to an image file (PNG, JPEG, WebP, SVG and others sharp reads), or the image bytes. */
export type IconSource = string | Uint8Array;

export interface RenderOptions {
  /** `cover` crops to fill the square, `contain` shrinks to fit inside it. Default `cover`. */
  fit?: 'cover' | 'contain';
  /** Fill behind the image where `contain` leaves gaps. Any CSS color. Default `transparent`. */
  background?: string;
}

export interface MaskableOptions extends RenderOptions {
  /** Margin on each side as a fraction of the icon size. Default 0.1, the PWA safe zone. Range 0 to 0.45. */
  inset?: number;
}

function open(source: IconSource, density?: number): Sharp {
  const input = typeof source === 'string' ? source : Buffer.from(source);
  return sharp(input, density ? { density } : undefined);
}

function checkSize(size: number): void {
  if (!Number.isInteger(size) || size < 1 || size > 16384) {
    throw new RangeError(`icon size must be an integer from 1 to 16384, got ${size}`);
  }
}

/** Renders the source as a square PNG of the given size. Vector sources are rasterised at the target size. */
export async function renderPng(source: IconSource, size: number, options: RenderOptions = {}): Promise<Buffer> {
  checkSize(size);
  const { fit = 'cover', background = 'transparent' } = options;
  let density: number | undefined;
  const meta = await open(source).metadata();
  if (meta.format === 'svg') {
    const longest = Math.max(meta.width ?? size, meta.height ?? size, 1);
    density = Math.min(2400, Math.max(72, Math.ceil((72 * size) / longest)));
  }
  return open(source, density)
    .resize(size, size, { fit, background, position: 'centre' })
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Renders a maskable icon: the source is scaled down to leave `inset` on each side
 * and placed on an opaque square of `background`, so launchers can crop it to any shape.
 */
export async function renderMaskable(source: IconSource, size: number, options: MaskableOptions = {}): Promise<Buffer> {
  checkSize(size);
  const { inset = 0.1, background = '#ffffff', fit = 'cover' } = options;
  if (!(inset >= 0 && inset <= 0.45)) throw new RangeError(`inset must be between 0 and 0.45, got ${inset}`);
  const margin = Math.round(size * inset);
  const art = Math.max(1, size - margin * 2);
  const mark = await renderPng(source, art, { fit, background: 'transparent' });
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: mark, left: margin, top: margin }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Renders the source at `size` with the artwork scaled to `scale` of the canvas and centred, on transparency. Used for the macOS icon grid. */
export async function renderScaled(source: IconSource, size: number, scale: number, options: RenderOptions = {}): Promise<Buffer> {
  checkSize(size);
  if (!(scale > 0 && scale <= 1)) throw new RangeError(`scale must be above 0 and at most 1, got ${scale}`);
  const art = Math.max(1, Math.round(size * scale));
  if (art === size) return renderPng(source, size, options);
  const mark = await renderPng(source, art, options);
  const left = Math.floor((size - art) / 2);
  return sharp({ create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: mark, left, top: left }])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/** Renders the source as a circular PNG, for Android round launcher icons. */
export async function renderRound(source: IconSource, size: number, options: RenderOptions = {}): Promise<Buffer> {
  const square = await renderPng(source, size, options);
  const circle = Buffer.from(
    `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="#fff"/></svg>`,
  );
  return sharp(square).composite([{ input: circle, blend: 'dest-in' }]).png({ compressionLevel: 9 }).toBuffer();
}

/** Renders the source onto an opaque square, for icons that must not be transparent such as the iOS home screen icon. */
export async function renderOpaque(source: IconSource, size: number, options: RenderOptions = {}): Promise<Buffer> {
  const { background = '#ffffff' } = options;
  const image = await renderPng(source, size, options);
  return sharp(image).flatten({ background }).png({ compressionLevel: 9 }).toBuffer();
}
