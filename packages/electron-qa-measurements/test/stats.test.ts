import { describe, expect, it } from 'vitest';
import { computeStats, generateText, modifierForPlatform, readArg } from '../src/index.js';

describe('computeStats', () => {
  it('returns only the sample count for no data', () => {
    expect(computeStats([])).toEqual({ samples: 0 });
  });

  it('uses nearest-rank percentiles and rounds to 0.1', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1.04);
    expect(computeStats(values)).toEqual({ samples: 100, p50: 50, p95: 95, max: 100 });
  });

  it('handles one value', () => {
    expect(computeStats([7.26])).toEqual({ samples: 1, p50: 7.3, p95: 7.3, max: 7.3 });
  });

  it('does not depend on input order and does not change the input', () => {
    const input = [30, 10, 20];
    expect(computeStats(input)).toEqual({ samples: 3, p50: 20, p95: 30, max: 30 });
    expect(input).toEqual([30, 10, 20]);
  });

  it('ignores values that are not finite', () => {
    expect(computeStats([Number.NaN, 5, Infinity])).toEqual({ samples: 1, p50: 5, p95: 5, max: 5 });
  });
});

describe('generateText', () => {
  it('returns exactly the requested length, deterministically', () => {
    expect(generateText(220)).toHaveLength(220);
    expect(generateText(220)).toBe(generateText(220));
    expect(generateText(0)).toBe('');
  });

  it('makes digits-and-signs text', () => {
    const text = generateText(50, 'digits');
    expect(text).toHaveLength(50);
    expect(text).toMatch(/^[0-9.+-]+$/);
  });

  it('rejects a bad length', () => {
    expect(() => generateText(-1)).toThrow(RangeError);
    expect(() => generateText(1.5)).toThrow(RangeError);
  });
});

describe('helpers', () => {
  it('reads --name=value arguments', () => {
    const argv = ['node', 'app', '--qa-typing=out.json', '--flag'];
    expect(readArg('qa-typing', argv)).toBe('out.json');
    expect(readArg('flag', argv)).toBeNull();
    expect(readArg('missing', argv)).toBeNull();
  });

  it('picks the palette modifier by platform', () => {
    expect(modifierForPlatform('darwin')).toBe('meta');
    expect(modifierForPlatform('macos')).toBe('meta');
    expect(modifierForPlatform('win32')).toBe('control');
    expect(modifierForPlatform('linux')).toBe('control');
  });
});
