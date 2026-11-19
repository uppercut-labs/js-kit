import vm from 'node:vm';
import type { InputEventLike, WindowLike } from '../src/index.js';

type Listener = (event: Record<string, unknown>) => void;

class FakeElement {
  value = '';
  listeners = new Map<string, Listener[]>();
  constructor(readonly page: FakePage) {}
  addEventListener(type: string, fn: Listener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  removeEventListener(type: string, fn: Listener) {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== fn));
  }
  focus() {
    this.page.active = this;
  }
  setSelectionRange() {}
  fire(type: string, event: Record<string, unknown>) {
    for (const l of this.listeners.get(type) ?? []) l(event);
  }
}

/**
 * A tiny page that runs the package's real in-page scripts inside a `vm` context,
 * with a field, an optional palette and input events delivered through `sendInputEvent`.
 */
export class FakePage {
  field = new FakeElement(this);
  active: FakeElement | null = null;
  paletteOpen = false;
  windowListeners = new Map<string, Listener[]>();
  observers: Array<(list: { getEntries(): Array<{ name: string; duration: number }> }) => void> = [];
  inputEvents: InputEventLike[] = [];
  readonly context: vm.Context;

  constructor(public selectors: Record<string, () => unknown> = {}) {
    const now = () => Number(process.hrtime.bigint()) / 1e6;
    const win: Record<string, unknown> = {};
    const page = this;
    Object.assign(win, {
      window: win,
      document: {
        querySelector: (selector: string) => (selector === '#field' ? page.field : selector === '.palette' ? (page.paletteOpen ? {} : null) : (page.selectors[selector]?.() ?? null)),
        get activeElement() {
          return page.active;
        },
      },
      addEventListener: (type: string, fn: Listener) => this.windowListeners.set(type, [...(this.windowListeners.get(type) ?? []), fn]),
      removeEventListener: (type: string, fn: Listener) => this.windowListeners.set(type, (this.windowListeners.get(type) ?? []).filter((l) => l !== fn)),
      requestAnimationFrame: (cb: () => void) => setTimeout(cb, 1),
      MessageChannel: class {
        port1: { onmessage: null | (() => void) } = { onmessage: null };
        port2 = { postMessage: () => queueMicrotask(() => this.port1.onmessage?.()) };
      },
      PerformanceObserver: class {
        constructor(cb: (list: { getEntries(): Array<{ name: string; duration: number }> }) => void) {
          page.observers.push(cb);
        }
        observe() {}
      },
      performance: { now, timeOrigin: Date.now() - now(), getEntriesByName: () => [{ startTime: 12 }] },
      String,
      Number,
    });
    this.context = vm.createContext(win);
  }

  emitSlow(duration: number) {
    for (const cb of this.observers) cb({ getEntries: () => [{ name: 'keydown', duration }] });
  }

  private ts() {
    return Number(process.hrtime.bigint()) / 1e6;
  }

  sendInputEvent(event: InputEventLike) {
    this.inputEvents.push(event);
    const mods = event.modifiers ?? [];
    if (event.type === 'keyDown') {
      const e = { key: event.keyCode, ctrlKey: mods.includes('control'), metaKey: mods.includes('meta'), timeStamp: this.ts() };
      for (const l of this.windowListeners.get('keydown') ?? []) l(e);
      if (e.key.toLowerCase() === 'k' && (e.ctrlKey || e.metaKey)) this.paletteOpen = true;
      if (e.key === 'Escape') this.paletteOpen = false;
      (this.active ?? this.field).fire('keydown', e);
    } else if (event.type === 'char' && this.active === this.field) {
      this.field.value += event.keyCode === '\r' ? '\n' : event.keyCode;
      this.field.fire('input', { timeStamp: this.ts() });
    }
  }

  window(): WindowLike {
    const page = this;
    return {
      webContents: {
        executeJavaScript: async (source: string) => vm.runInContext(source, page.context) as unknown,
        sendInputEvent: (event) => page.sendInputEvent(event),
        focus() {},
      },
    };
  }
}

export const quickSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 3)));
