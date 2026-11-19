import type { Stats } from './types.js';

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Nearest-rank percentiles of the finite values, rounded to 0.1 ms. */
export function computeStats(values: readonly number[]): Stats {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return { samples: 0 };
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
  return { samples: sorted.length, p50: round1(at(0.5)), p95: round1(at(0.95)), max: round1(sorted[sorted.length - 1]!) };
}

export type SampleKind = 'prose' | 'digits';

const WORDS = 'the quick brown fox jumps over the lazy dog while the mix is rendering and nobody is watching the meters'.split(' ');
const DIGIT_KEYS = '1234567890.+-';

/** Deterministic text of exactly `count` characters to type into a field. */
export function generateText(count: number, kind: SampleKind = 'prose'): string {
  if (!Number.isInteger(count) || count < 0) throw new RangeError('count must be a non-negative integer');
  let out = '';
  if (kind === 'digits') {
    for (let i = 0; out.length < count; i++) out += DIGIT_KEYS[(i * 7) % DIGIT_KEYS.length];
    return out.slice(0, count);
  }
  for (let i = 0; out.length < count; i++) out += (i % 14 === 13 ? '\n' : '') + WORDS[i % WORDS.length] + ' ';
  return out.slice(0, count);
}
