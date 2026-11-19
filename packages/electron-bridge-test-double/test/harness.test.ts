import { describe, expect, it } from 'vitest';
import { createBridgeHarness, installBridgeIfMissing } from '../src/index.js';

describe('createBridgeHarness', () => {
  it('wires the log, menu hook and fixture from the address', () => {
    const target: Record<string, unknown> = {};
    const h = createBridgeHarness<{ items: string[] }>({
      storagePrefix: 'app',
      target,
      address: '#fixture=two&platform=macos',
      fixtures: { table: { one: { items: ['a'] }, two: { items: ['a', 'b'] } }, fallback: 'one' },
    });
    expect(h.fixture).toEqual({ name: 'two', data: { items: ['a', 'b'] } });
    expect(h.option('platform', ['windows', 'macos'] as const, 'windows')).toBe('macos');
    expect(h.option('platform', ['linux'] as const, 'linux')).toBe('linux');

    const seen: string[] = [];
    h.menuCommands.add((c) => seen.push(c));
    (target.__menuCommand as (c: string) => void)('view.zoom');
    expect(seen).toEqual(['view.zoom']);

    h.log.record('bootstrap');
    expect(target.__desktopCalls).toEqual([{ name: 'bootstrap', args: [] }]);
  });

  it('works without fixtures', () => {
    const h = createBridgeHarness({ storagePrefix: 'app', target: {}, address: '' });
    expect(h.fixture).toEqual({ name: undefined, data: undefined });
    expect(h.fixtures).toBeUndefined();
  });

  it('gives the same channel for the same name', () => {
    const h = createBridgeHarness({ storagePrefix: 'app', target: {}, address: '' });
    const seen: number[] = [];
    h.channel<number>('progress').add((v) => seen.push(v));
    h.channel<number>('progress').emit(4);
    h.channel<number>('other').emit(5);
    expect(seen).toEqual([4]);
  });
});

describe('installBridgeIfMissing', () => {
  it('installs the fake when the real bridge is absent', () => {
    const target: Record<string, unknown> = {};
    const bridge = installBridgeIfMissing(() => ({ fake: true }), { target });
    expect(bridge).toEqual({ fake: true });
    expect(target.desktop).toBe(bridge);
  });

  it('leaves a real bridge alone and does not build the fake', () => {
    const real = { real: true };
    const target: Record<string, unknown> = { desktop: real };
    let built = false;
    const bridge = installBridgeIfMissing(
      () => {
        built = true;
        return { fake: true };
      },
      { target },
    );
    expect(bridge).toBe(real);
    expect(built).toBe(false);
  });

  it('uses a custom property name', () => {
    const target: Record<string, unknown> = {};
    installBridgeIfMissing(() => 1, { target, name: 'shell' });
    expect(target.shell).toBe(1);
  });
});
