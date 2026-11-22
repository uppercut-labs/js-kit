import { describe, expect, it } from 'vitest';
import { descendants, measureMemory, parseFootprint, parsePs, smapsValue, systemOf } from '../src/index.js';

const at = () => new Date('2026-01-01T00:00:00Z');

describe('pieces', () => {
  it('walks a process tree from its root', () => {
    expect(descendants(10, [[11, 10], [12, 11], [13, 1], [14, 12]])).toEqual([10, 11, 12, 14]);
    expect(parsePs('  10     1\n  11    10\n\n')).toEqual([[10, 1], [11, 10]]);
  });

  it('reads footprint and smaps_rollup output', () => {
    const out = parseFootprint('Example [101]: 64-bit    Footprint: 104857600 B (16384 bytes per page)\nExample Helper (GPU) [102]: 64-bit    Footprint: 52428800 B\nSummary Footprint: 157286400 B\n');
    expect(out.detail).toEqual([
      { pid: 101, name: 'Example', privateMB: 100 },
      { pid: 102, name: 'Example Helper (GPU)', privateMB: 50 },
    ]);
    expect(out.totalBytes).toBe(157286400);
    expect(smapsValue('Rss:  2048 kB\nAnonymous:   1024 kB\nSwap:  0 kB\n', 'Anonymous')).toBe(1024);
    expect(smapsValue('Rss: 1 kB\n', 'Swap')).toBe(0);
    expect(systemOf('win32')).toBe('windows');
    expect(systemOf('darwin')).toBe('macos');
    expect(systemOf('linux')).toBe('linux');
  });
});

describe('measureMemory', () => {
  it('Windows: private bytes of the processes Electron started, against the budget', async () => {
    const report = await measureMemory({
      system: 'windows',
      root: 7,
      now: at,
      getAppMetrics: () => [
        { pid: 7, type: 'Browser', memory: { privateBytes: 102400, workingSetSize: 204800 } },
        { pid: 8, type: 'GPU', memory: { privateBytes: 256000, workingSetSize: 300000 } },
      ],
    });
    expect(report).toMatchObject({ system: 'windows', definition: 'private bytes', processes: 2, privateMB: 350, budgetMB: 300, ceilingMB: 680, withinBudget: false, underCeiling: true, at: '2026-01-01T00:00:00.000Z' });
    expect(report.detail[0]).toEqual({ pid: 7, name: 'Browser', privateMB: 100, residentMB: 200 });
  });

  it('Windows without getAppMetrics says so instead of reporting zero as a measurement', async () => {
    const report = await measureMemory({ system: 'windows', now: at });
    expect(report.error).toMatch(/getAppMetrics/);
    expect(report.processes).toBe(0);
  });

  it('macOS: phys_footprint over the tree, totalled by footprint itself', async () => {
    const calls: string[][] = [];
    const report = await measureMemory({
      system: 'macos',
      root: 101,
      now: at,
      budgetMB: 120,
      run: async (file, args) => {
        calls.push([file, ...args]);
        if (file === '/bin/ps') return { error: null, stdout: '101 1\n102 101\n999 1\n' };
        return { error: null, stdout: 'Example [101]: 64-bit    Footprint: 104857600 B\nExample Helper [102]: 64-bit    Footprint: 52428800 B\nSummary Footprint: 157286400 B\n' };
      },
    });
    expect(calls[1]).toEqual(['/usr/bin/footprint', '-f', 'bytes', '--noCategories', '--pid', '101', '--pid', '102']);
    expect(report).toMatchObject({ definition: 'phys_footprint', processes: 2, privateMB: 150, withinBudget: false, underCeiling: true });
  });

  it('Linux: anonymous memory plus swap over the tree; a process that cannot be read is listed, not dropped', async () => {
    const files: Record<string, string> = {
      '/proc/50/stat': '50 (example) S 1 50',
      '/proc/51/stat': '51 (example helper) S 50 50',
      '/proc/52/stat': '52 (other) S 1 52',
      '/proc/50/smaps_rollup': 'Rss: 204800 kB\nAnonymous: 102400 kB\nSwap: 1024 kB\n',
      '/proc/50/comm': 'example\n',
    };
    const report = await measureMemory({
      system: 'linux',
      root: 50,
      now: at,
      listProc: () => ['50', '51', '52', 'self'],
      readFile: (file) => {
        const text = files[file];
        if (text === undefined) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        return text;
      },
    });
    expect(report.detail).toEqual([
      { pid: 50, name: 'example', privateMB: 101, residentMB: 200 },
      { pid: 51, name: null, privateMB: 0, unreadable: 'ENOENT' },
    ]);
    expect(report.privateMB).toBe(101);
  });
});
