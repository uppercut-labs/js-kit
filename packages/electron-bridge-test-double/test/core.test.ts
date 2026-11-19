import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createCallLog,
  createEmitter,
  createPrefixedStorage,
  createScheduler,
  defineFixtures,
  installMenuHook,
  instrument,
  parseHashParams,
  readOption,
  type StorageLike,
} from '../src/index.js';

afterEach(() => vi.useRealTimers());

function memoryStorage(initial: Record<string, string> = {}, failWrites = false): StorageLike & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    get length() {
      return Object.keys(data).length;
    },
    key: (i) => Object.keys(data)[i] ?? null,
    getItem: (k) => data[k] ?? null,
    setItem(k, v) {
      if (failWrites) throw new Error('quota');
      data[k] = v;
    },
  };
}

describe('createEmitter', () => {
  it('delivers values to listeners and supports unsubscribing', () => {
    const emitter = createEmitter<number>();
    const seen: number[] = [];
    const off = emitter.add((v) => seen.push(v));
    emitter.emit(1);
    off();
    emitter.emit(2);
    expect(seen).toEqual([1]);
    expect(emitter.size).toBe(0);
  });

  it('keeps delivering after a listener throws, then rethrows the first error', () => {
    const emitter = createEmitter<number>();
    const seen: number[] = [];
    emitter.add(() => {
      throw new Error('first');
    });
    emitter.add((v) => seen.push(v));
    expect(() => emitter.emit(5)).toThrow('first');
    expect(seen).toEqual([5]);
  });

  it('lets a listener remove itself during emit', () => {
    const emitter = createEmitter<number>();
    let calls = 0;
    const off = emitter.add(() => {
      calls++;
      off();
    });
    emitter.emit(1);
    emitter.emit(2);
    expect(calls).toBe(1);
  });

  it('clears all listeners', () => {
    const emitter = createEmitter<number>();
    emitter.add(() => {});
    emitter.clear();
    expect(emitter.size).toBe(0);
  });
});

describe('createCallLog and instrument', () => {
  it('records calls and publishes the array on the target', () => {
    const target: Record<string, unknown> = {};
    const log = createCallLog({ target });
    log.record('launch', 'a', 1);
    log.record('rescan');
    expect(target.__desktopCalls).toBe(log.calls);
    expect(log.calls).toEqual([
      { name: 'launch', args: ['a', 1] },
      { name: 'rescan', args: [] },
    ]);
    expect(log.callsTo('launch')).toHaveLength(1);
    log.clear();
    expect(target.__desktopCalls).toEqual([]);
  });

  it('can publish under another name or not at all', () => {
    const target: Record<string, unknown> = {};
    createCallLog({ target, exposeAs: 'calls' });
    createCallLog({ target, exposeAs: null });
    expect(Object.keys(target)).toEqual(['calls']);
  });

  it('records each call of an implementation, with optional argument selection', async () => {
    const log = createCallLog({ exposeAs: null });
    const bridge = instrument(
      {
        version: 3,
        async load(id: string) {
          return `loaded ${id}`;
        },
        save(key: string, _big: string) {
          return key;
        },
      },
      log,
      { save: (args) => [args[0]] },
    );
    expect(bridge.version).toBe(3);
    expect(await bridge.load('x')).toBe('loaded x');
    bridge.save('k', 'huge payload');
    expect(log.calls).toEqual([
      { name: 'load', args: ['x'] },
      { name: 'save', args: ['k'] },
    ]);
  });
});

describe('installMenuHook', () => {
  it('sends commands and keeps the menu state', () => {
    const target: Record<string, unknown> = {};
    const emitter = createEmitter<string>();
    const seen: string[] = [];
    emitter.add((c) => seen.push(c));
    const hook = installMenuHook(emitter, { target });
    (target.__menuCommand as (id: string) => void)('file.open');
    hook.command('file.save');
    hook.setMenuState({ save: true });
    expect(seen).toEqual(['file.open', 'file.save']);
    expect(target.__menuState).toEqual({ save: true });
  });

  it('uses custom property names', () => {
    const target: Record<string, unknown> = {};
    installMenuHook(createEmitter<string>(), { target, commandKey: 'sendMenu' }).setMenuState({});
    expect(typeof target.sendMenu).toBe('function');
  });
});

describe('address options and fixtures', () => {
  it('parses a hash, a full URL and a query', () => {
    expect(parseHashParams('#fixture=empty&platform=macos').get('platform')).toBe('macos');
    expect(parseHashParams('https://example.test/app#fixture=dense').get('fixture')).toBe('dense');
    expect(parseHashParams('?a=1').get('a')).toBe('1');
    expect(parseHashParams('').get('a')).toBeNull();
  });

  it('reads an option only when it is allowed', () => {
    const allowed = ['windows', 'macos', 'linux'] as const;
    expect(readOption('platform', allowed, 'windows', '#platform=macos')).toBe('macos');
    expect(readOption('platform', allowed, 'windows', '#platform=beos')).toBe('windows');
    expect(readOption('platform', allowed, 'linux', '')).toBe('linux');
  });

  it('selects a fixture from the address and falls back for unknown names', () => {
    const fixtures = defineFixtures({ default: { n: 1 }, empty: { n: 0 }, built: () => ({ n: 9 }) }, 'default');
    expect(fixtures.select('#fixture=empty')).toEqual({ name: 'empty', data: { n: 0 } });
    expect(fixtures.select('#fixture=built').data).toEqual({ n: 9 });
    expect(fixtures.select('#fixture=nope').name).toBe('default');
    expect(fixtures.select('').name).toBe('default');
    expect(fixtures.select('#scenario=empty', 'scenario').name).toBe('empty');
    expect(fixtures.names).toEqual(['default', 'empty', 'built']);
    expect(fixtures.has('empty')).toBe(true);
  });

  it('clones fixture data so changes do not leak between selections', () => {
    const fixtures = defineFixtures({ default: { list: [1] } }, 'default');
    fixtures.get('default').list.push(2);
    expect(fixtures.get('default').list).toEqual([1]);
  });

  it('rejects an unknown name and a missing fallback', () => {
    expect(() => defineFixtures({ a: 1 }, 'b')).toThrow('not in the table');
    expect(() => defineFixtures({ a: 1 }, 'a').get('z')).toThrow('Unknown fixture');
  });
});

describe('createPrefixedStorage', () => {
  it('loads only entries under the prefix', () => {
    const backing = memoryStorage({ 'app.view': '{"a":1}', 'other.x': '1' });
    expect(createPrefixedStorage('app', backing).load()).toEqual({ 'app.view': '{"a":1}' });
  });

  it('saves to storage and keeps the value in memory', () => {
    const backing = memoryStorage();
    const store = createPrefixedStorage('app', backing);
    store.save('app.view', '1');
    expect(backing.data).toEqual({ 'app.view': '1' });
    expect(store.memory).toEqual({ 'app.view': '1' });
  });

  it('survives a storage that refuses writes', () => {
    const store = createPrefixedStorage('app', memoryStorage({}, true));
    expect(() => store.save('app.view', '1')).not.toThrow();
    expect(store.load()).toEqual({ 'app.view': '1' });
  });

  it('survives a storage that throws on read', () => {
    const broken: StorageLike = {
      get length(): number {
        throw new Error('blocked');
      },
      key: () => null,
      getItem: () => null,
      setItem() {},
    };
    expect(createPrefixedStorage('app', broken).load()).toEqual({});
  });

  it('works with no storage at all', () => {
    const store = createPrefixedStorage('app', undefined);
    store.save('app.a', '1');
    expect(store.load()).toEqual({ 'app.a': '1' });
  });
});

describe('createScheduler', () => {
  it('runs a timer after its delay', () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const fn = vi.fn();
    scheduler.after(100, fn);
    expect(scheduler.pending).toBe(1);
    vi.advanceTimersByTime(99);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledOnce();
    expect(scheduler.pending).toBe(0);
  });

  it('cancels one timer', () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const fn = vi.fn();
    const cancel = scheduler.after(50, fn);
    cancel();
    cancel();
    vi.advanceTimersByTime(100);
    expect(fn).not.toHaveBeenCalled();
  });

  it('cancels everything, and waits resolve false', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const fn = vi.fn();
    scheduler.after(50, fn);
    const waiting = scheduler.wait(1000);
    scheduler.cancelAll();
    expect(await waiting).toBe(false);
    vi.advanceTimersByTime(2000);
    expect(fn).not.toHaveBeenCalled();
    expect(scheduler.pending).toBe(0);
  });

  it('wait resolves true when it runs out', async () => {
    vi.useFakeTimers();
    const scheduler = createScheduler();
    const waiting = scheduler.wait(10);
    vi.advanceTimersByTime(10);
    expect(await waiting).toBe(true);
  });

  it('accepts injected timer functions', () => {
    const calls: string[] = [];
    const scheduler = createScheduler({
      setTimeout: (fn, ms) => {
        calls.push(`set ${ms}`);
        fn();
        return 1;
      },
      clearTimeout: () => calls.push('clear'),
    });
    const fn = vi.fn();
    scheduler.after(5, fn);
    expect(fn).toHaveBeenCalledOnce();
    expect(calls).toEqual(['set 5']);
  });
});
