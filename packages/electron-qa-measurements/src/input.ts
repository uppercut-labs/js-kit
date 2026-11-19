import type { CommonOptions, InputEventLike, KeyInjector, WebContentsLike } from './types.js';

const KEY_NAMES: Record<string, string> = { ' ': 'Space', '\n': 'Enter' };

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Key presses through `webContents.sendInputEvent`, which uses Chromium's input pipeline. */
export function createInputEventInjector(contents: Pick<WebContentsLike, 'sendInputEvent'>): KeyInjector {
  return {
    press(key, modifiers) {
      const keyCode = KEY_NAMES[key] ?? key;
      const hasModifiers = !!modifiers && modifiers.length > 0;
      const mods = hasModifiers ? { modifiers: [...modifiers!] } : {};
      const send = (event: InputEventLike) => contents.sendInputEvent(event);
      send({ type: 'keyDown', keyCode, ...mods });
      // A character key also produces a `char` event so the text field receives it.
      if (key.length === 1 && !hasModifiers) send({ type: 'char', keyCode: key === '\n' ? '\r' : key });
      send({ type: 'keyUp', keyCode, ...mods });
    },
  };
}

export type ProtocolSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

const MODIFIER_BITS: Record<string, number> = { alt: 1, control: 2, ctrl: 2, meta: 4, command: 4, shift: 8 };

/**
 * Key presses through the DevTools protocol (`Input.dispatchKeyEvent`). `send` is
 * `(method, params) => webContents.debugger.sendCommand(method, params)`. Nothing
 * is sent to the operating system, so the window never needs focus.
 */
export function createProtocolInjector(send: ProtocolSend): KeyInjector {
  return {
    async press(key, modifiers = []) {
      const bits = modifiers.reduce((acc, m) => acc | (MODIFIER_BITS[m.toLowerCase()] ?? 0), 0);
      const printable = key.length === 1 && bits === 0;
      const base = { key: key === '\n' ? 'Enter' : key, modifiers: bits };
      await send('Input.dispatchKeyEvent', printable ? { ...base, type: 'keyDown', text: key === '\n' ? '\r' : key } : { ...base, type: 'rawKeyDown' });
      await send('Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
    },
  };
}

/** Makes the page behave as focused although its window is not. Call once after attaching the debugger. */
export async function emulatePageFocus(send: ProtocolSend): Promise<void> {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
}

/** `meta` on macOS (`darwin`), `control` elsewhere: the usual command-palette modifier. */
export function modifierForPlatform(platform: string = process.platform): 'meta' | 'control' {
  return platform === 'darwin' || platform === 'macos' ? 'meta' : 'control';
}

export function resolveInjector(contents: WebContentsLike, options: CommonOptions): KeyInjector {
  return options.injector ?? createInputEventInjector(contents);
}
