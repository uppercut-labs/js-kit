/** One PNG image inside an ICO file. `size` is the width and height in pixels (1 to 256). */
export interface IcoFrame {
  size: number;
  data: Uint8Array;
}

/** One image inside an ICNS file. `type` is the four-character type code, such as `ic10`. */
export interface IcnsFrame {
  type: string;
  data: Uint8Array;
}

/** Packs PNG images into a Windows ICO file. A 256 pixel frame is stored with size 0, as the format requires. */
export function packIco(frames: readonly IcoFrame[]): Buffer {
  if (frames.length === 0) throw new RangeError('packIco needs at least one frame');
  if (frames.length > 0xffff) throw new RangeError('an ICO file holds at most 65535 frames');
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, data }, index) => {
    if (!Number.isInteger(size) || size < 1 || size > 256) {
      throw new RangeError(`ICO frame size must be an integer from 1 to 256, got ${size}`);
    }
    const entry = 6 + index * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(data.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...frames.map((frame) => Buffer.from(frame.data))]);
}

/** Packs PNG images into a macOS ICNS file. Frames are written in the order given. */
export function packIcns(frames: readonly IcnsFrame[]): Buffer {
  if (frames.length === 0) throw new RangeError('packIcns needs at least one frame');
  const chunks = frames.map(({ type, data }) => {
    if (!/^[\x20-\x7e]{4}$/.test(type)) {
      throw new RangeError(`ICNS type code must be four printable ASCII characters, got "${type}"`);
    }
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, Buffer.from(data)]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/** ICNS type codes whose payload is a PNG, with the pixel size each one holds. */
export const ICNS_PNG_TYPES: ReadonlyArray<readonly [type: string, size: number]> = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];
