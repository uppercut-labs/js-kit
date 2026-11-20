/** Summary of a set of timings in milliseconds. `samples` is 0 when there was nothing to measure. */
export interface Stats {
  samples: number;
  p50?: number;
  p95?: number;
  max?: number;
}

/** Presses keys in the page. `modifiers` use Electron's names: `control`, `meta`, `shift`, `alt`. */
export interface KeyInjector {
  press(key: string, modifiers?: readonly string[]): void | Promise<void>;
}

export interface InputEventLike {
  type: string;
  keyCode: string;
  modifiers?: string[];
}

/** The parts of Electron's `webContents` the measurements use. */
export interface WebContentsLike {
  executeJavaScript(source: string): Promise<unknown>;
  sendInputEvent(event: InputEventLike): void;
  focus?(): void;
  reload?(): void;
  once?(event: string, listener: () => void): unknown;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The parts of Electron's `BrowserWindow` the measurements use. A real `BrowserWindow` satisfies it. */
export interface WindowLike {
  webContents: WebContentsLike;
  getBounds?(): Bounds;
  isVisible?(): boolean;
  isFocused?(): boolean;
  close?(): void;
}

/** Options every scenario accepts so tests can run without real time or real input. */
export interface CommonOptions {
  /** Defaults to a `setTimeout` wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Defaults to an injector that sends `webContents.sendInputEvent` events. */
  injector?: KeyInjector;
  /**
   * Whether to call `webContents.focus()` before typing. On macOS that makes the window the key
   * window, which takes the user's focus. The default `sendInputEvent` injector needs it, so the
   * default is true without an `injector` and false with one (a protocol injector with
   * `emulatePageFocus` reaches the page without the window ever being focused).
   */
  focusWindow?: boolean;
}
