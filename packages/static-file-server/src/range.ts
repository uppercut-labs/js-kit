export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Parses one `Range: bytes=...` header against a file size.
 *
 * Returns a satisfiable inclusive range, `'unsatisfiable'` when it lies outside the file (answer 416),
 * or `null` when the whole file should be sent: no header, another unit, a malformed value or several
 * ranges. Suffix ranges (`bytes=-500`) and open-ended ranges (`bytes=100-`) are supported, and an end
 * past the last byte is clamped.
 */
export function parseRange(header: string | undefined, size: number): ByteRange | 'unsatisfiable' | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match === null) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;
  if (first === '') {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}
