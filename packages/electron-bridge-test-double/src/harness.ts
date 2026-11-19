import {
  createCallLog,
  createEmitter,
  createPrefixedStorage,
  createScheduler,
  defineFixtures,
  installMenuHook,
  parseHashParams,
  type CallLog,
  type Emitter,
  type FixtureSet,
  type MenuHook,
  type PrefixedStorage,
  type Scheduler,
  type StorageLike,
} from './core.js';

export interface HarnessOptions<D> {
  /** Prefix of the storage keys the bridge saves, matched as `<prefix>.`. */
  storagePrefix: string;
  /** Named scenarios, and the one used when the address names none. */
  fixtures?: { table: Record<string, D | (() => D)>; fallback: string };
  /** Address to read options from. Default `location.hash`. */
  address?: string;
  /** Object that receives `__desktopCalls`, `__menuCommand` and `__menuState`. Default `globalThis`. */
  target?: object;
  storage?: StorageLike;
}

export interface Harness<D> {
  readonly log: CallLog;
  readonly menu: MenuHook;
  readonly storage: PrefixedStorage;
  readonly scheduler: Scheduler;
  /** The menu command emitter, for `onMenuCommand`. */
  readonly menuCommands: Emitter<string>;
  /** The selected fixture; `undefined` name and data when no fixtures were given. */
  readonly fixture: { name: string; data: D } | { name: undefined; data: undefined };
  readonly fixtures: FixtureSet<D> | undefined;
  /** An option from the address, for example `platform`. */
  option<T extends string>(name: string, allowed: readonly T[], fallback: T): T;
  /** A named event channel, created on first use. */
  channel<T>(name: string): Emitter<T>;
}

/**
 * Wires the pieces a fake bridge needs: call log, menu hook, event channels, fixture selection from the
 * address, safe storage and cancellable timers.
 */
export function createBridgeHarness<D = never>(options: HarnessOptions<D>): Harness<D> {
  const { target } = options;
  const log = createCallLog({ target });
  const menuCommands = createEmitter<string>();
  const menu = installMenuHook(menuCommands, { target });
  const channels = new Map<string, Emitter<unknown>>();
  const fixtures = options.fixtures ? defineFixtures<D>(options.fixtures.table, options.fixtures.fallback) : undefined;
  const fixture = fixtures ? fixtures.select(options.address) : { name: undefined, data: undefined };
  return {
    log,
    menu,
    menuCommands,
    storage: createPrefixedStorage(options.storagePrefix, options.storage),
    scheduler: createScheduler(),
    fixture: fixture as Harness<D>['fixture'],
    fixtures,
    option(name, allowed, fallback) {
      const value = parseHashParams(options.address).get(name);
      return (allowed as readonly string[]).includes(value ?? '') ? (value as typeof fallback) : fallback;
    },
    channel<T>(name: string) {
      let channel = channels.get(name);
      if (!channel) channels.set(name, (channel = createEmitter<unknown>()));
      return channel as Emitter<T>;
    },
  };
}

export interface InstallOptions {
  /** Object that holds the bridge. Default `globalThis`. */
  target?: object;
  /** Property name. Default `desktop`. */
  name?: string;
}

/**
 * Installs the fake when the real preload bridge is absent, and returns whichever bridge is in place.
 * `create` is only called when needed, so the fake can live in its own lazily loaded chunk.
 */
export function installBridgeIfMissing<B>(create: () => B, options: InstallOptions = {}): B {
  const target = (options.target ?? globalThis) as Record<string, unknown>;
  const name = options.name ?? 'desktop';
  if (target[name] === undefined) target[name] = create();
  return target[name] as B;
}
