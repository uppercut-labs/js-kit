// ---- event emitters ----------------------------------------------------------------

export type Listener<T> = (value: T) => void;

export interface Emitter<T> {
  /** Adds a listener and returns a function that removes it. */
  add(listener: Listener<T>): () => void;
  /** Calls every listener with `value`. A listener that throws does not stop the others; the first error is rethrown afterwards. */
  emit(value: T): void;
  readonly size: number;
  clear(): void;
}

/** A set of listeners, shaped like the `onSomething(listener) => unsubscribe` functions of a preload bridge. */
export function createEmitter<T>(): Emitter<T> {
  const listeners = new Set<Listener<T>>();
  return {
    add(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    emit(value) {
      let failure: { error: unknown } | undefined;
      for (const listener of [...listeners]) {
        try {
          listener(value);
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure) throw failure.error;
    },
    get size() {
      return listeners.size;
    },
    clear() {
      listeners.clear();
    },
  };
}

// ---- call log -----------------------------------------------------------------------

export interface Call {
  name: string;
  args: unknown[];
}

export interface CallLog {
  readonly calls: Call[];
  record(name: string, ...args: unknown[]): void;
  /** The calls made to one method, in order. */
  callsTo(name: string): Call[];
  clear(): void;
}

export interface CallLogOptions {
  /** Where to publish the log array, for scripts that read it. Default `globalThis`. */
  target?: object;
  /** Property name on `target`. Default `__desktopCalls`. Use `null` to publish nothing. */
  exposeAs?: string | null;
}

/** Records every bridge call as `{ name, args }`, and publishes the array on `window.__desktopCalls`. */
export function createCallLog(options: CallLogOptions = {}): CallLog {
  const calls: Call[] = [];
  const key = options.exposeAs === undefined ? '__desktopCalls' : options.exposeAs;
  if (key !== null) ((options.target ?? globalThis) as Record<string, unknown>)[key] = calls;
  return {
    calls,
    record(name, ...args) {
      calls.push({ name, args });
    },
    callsTo: (name) => calls.filter((c) => c.name === name),
    clear() {
      calls.length = 0;
    },
  };
}

export type ArgSelector = (args: unknown[]) => unknown[];

/**
 * Wraps every function in `implementation` so each call is recorded before it runs.
 * `selectArgs` can reduce the arguments that are logged for a method, for example to leave out a large payload.
 * Non-function properties are copied as they are.
 */
export function instrument<T extends object>(implementation: T, log: Pick<CallLog, 'record'>, selectArgs: Record<string, ArgSelector> = {}): T {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(implementation)) {
    if (typeof value !== 'function') {
      out[name] = value;
      continue;
    }
    out[name] = function (this: unknown, ...args: unknown[]) {
      log.record(name, ...(selectArgs[name] ? selectArgs[name]!(args) : args));
      return (value as (...a: unknown[]) => unknown).apply(implementation, args);
    };
  }
  return out as T;
}

// ---- menu hook ----------------------------------------------------------------------

export interface MenuHookOptions {
  target?: object;
  /** Name of the function that sends a menu command. Default `__menuCommand`. */
  commandKey?: string;
  /** Name of the property that holds the last menu state. Default `__menuState`. */
  stateKey?: string;
}

export interface MenuHook {
  /** Store the menu state the page last asked for. */
  setMenuState(enabled: Record<string, boolean>): void;
  /** Send a command as the application menu would. */
  command(id: string): void;
}

/** Makes `window.__menuCommand(id)` emit a command, and keeps the last menu state in `window.__menuState`. */
export function installMenuHook(emitter: Emitter<string>, options: MenuHookOptions = {}): MenuHook {
  const target = (options.target ?? globalThis) as Record<string, unknown>;
  const commandKey = options.commandKey ?? '__menuCommand';
  const stateKey = options.stateKey ?? '__menuState';
  const command = (id: string) => emitter.emit(id);
  target[commandKey] = command;
  return {
    command,
    setMenuState(enabled) {
      target[stateKey] = enabled;
    },
  };
}

// ---- address options and fixtures ----------------------------------------------------

/** Parses `#fixture=default&platform=macos` (or a full URL, or a bare query) into search params. */
export function parseHashParams(source: string = typeof location === 'undefined' ? '' : location.hash): URLSearchParams {
  const hashAt = source.indexOf('#');
  const text = hashAt >= 0 ? source.slice(hashAt + 1) : source.replace(/^\?/, '');
  return new URLSearchParams(text);
}

/** The value of option `name` when it is one of `allowed`, otherwise `fallback`. */
export function readOption<T extends string>(name: string, allowed: readonly T[], fallback: T, source?: string): T {
  const value = parseHashParams(source).get(name);
  return (allowed as readonly string[]).includes(value ?? '') ? (value as T) : fallback;
}

export interface FixtureSet<D> {
  readonly names: string[];
  readonly fallback: string;
  has(name: string): boolean;
  /** Picks the fixture named by the address (`fixture=` by default), falling back when it is missing or unknown. Data is cloned on every call. */
  select(source?: string, param?: string): { name: string; data: D };
  /** The data of a named fixture, cloned. Throws for an unknown name. */
  get(name: string): D;
}

/** A table of named scenarios. Each value is data, or a function that builds it. */
export function defineFixtures<D>(table: Record<string, D | (() => D)>, fallback: string): FixtureSet<D> {
  const names = Object.keys(table);
  if (!names.includes(fallback)) throw new Error(`Fallback fixture "${fallback}" is not in the table`);
  const build = (name: string): D => {
    const entry = table[name];
    return typeof entry === 'function' ? (entry as () => D)() : structuredClone(entry as D);
  };
  return {
    names,
    fallback,
    has: (name) => names.includes(name),
    get(name) {
      if (!names.includes(name)) throw new Error(`Unknown fixture "${name}"`);
      return build(name);
    },
    select(source, param = 'fixture') {
      const asked = parseHashParams(source).get(param);
      const name = asked !== null && names.includes(asked) ? asked : fallback;
      return { name, data: build(name) };
    },
  };
}

// ---- storage ---------------------------------------------------------------------------

export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface PrefixedStorage {
  /** Every saved entry whose key starts with `<prefix>.`. An unavailable storage gives an empty object. */
  load(): Record<string, string>;
  /** Saves one entry. Failures (quota, blocked storage) are swallowed and the value is kept in memory. */
  save(key: string, json: string): void;
  /** What `save` and `load` hold in memory, for assertions. */
  readonly memory: Record<string, string>;
}

/** Local storage that never throws, for state the bridge saves for the page. Defaults to `localStorage`. */
export function createPrefixedStorage(prefix: string, storage?: StorageLike): PrefixedStorage {
  let backing: StorageLike | undefined = storage;
  if (!backing) {
    try {
      backing = typeof localStorage === 'undefined' ? undefined : localStorage;
    } catch {
      backing = undefined;
    }
  }
  const memory: Record<string, string> = {};
  return {
    memory,
    load() {
      const found: Record<string, string> = {};
      try {
        for (let i = 0; backing && i < backing.length; i++) {
          const key = backing.key(i);
          if (key?.startsWith(`${prefix}.`)) found[key] = backing.getItem(key) ?? '';
        }
      } catch {
        return { ...memory };
      }
      return { ...found, ...memory };
    },
    save(key, json) {
      memory[key] = json;
      try {
        backing?.setItem(key, json);
      } catch {
        // The page keeps its view in memory.
      }
    },
  };
}

// ---- timers ----------------------------------------------------------------------------

export interface Scheduler {
  /** Runs `fn` after `ms`. Returns a function that cancels it. */
  after(ms: number, fn: () => void): () => void;
  /** Resolves after `ms`. Resolves early, with `false`, when cancelled by `cancelAll`; `true` otherwise. */
  wait(ms: number): Promise<boolean>;
  /** Cancels every pending timer. */
  cancelAll(): void;
  readonly pending: number;
}

export interface TimerFunctions {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Scripted timers that can all be cancelled, for events a fixture sends a moment after a call. */
export function createScheduler(timers: TimerFunctions = { setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as never) }): Scheduler {
  const pending = new Map<number, { handle: unknown; onCancel?: () => void }>();
  let nextId = 1;
  const start = (ms: number, fn: () => void, onCancel?: () => void) => {
    const id = nextId++;
    const handle = timers.setTimeout(() => {
      pending.delete(id);
      fn();
    }, ms);
    pending.set(id, { handle, onCancel });
    return () => {
      const entry = pending.get(id);
      if (!entry) return;
      pending.delete(id);
      timers.clearTimeout(entry.handle);
      entry.onCancel?.();
    };
  };
  return {
    after: (ms, fn) => start(ms, fn),
    wait: (ms) => new Promise<boolean>((resolve) => void start(ms, () => resolve(true), () => resolve(false))),
    cancelAll() {
      for (const id of [...pending.keys()]) {
        const entry = pending.get(id)!;
        pending.delete(id);
        timers.clearTimeout(entry.handle);
        entry.onCancel?.();
      }
    },
    get pending() {
      return pending.size;
    },
  };
}

/** A promise that resolves after `ms`. */
export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
