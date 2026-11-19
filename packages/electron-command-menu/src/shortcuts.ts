/** Platforms the shortcut helpers format for. Linux uses the same labels as Windows. */
export type ShortcutPlatform = 'windows' | 'macos';

/**
 * A keyboard shortcut. `mod` is Ctrl on Windows and Linux and Command on macOS.
 * `key` is a `KeyboardEvent.key` value such as "e", "ArrowUp", "Enter" or " ".
 */
export interface Shortcut {
  key: string;
  mod?: boolean;
  shift?: boolean;
  alt?: boolean;
}

/** The part of a keyboard event the matcher reads. */
export interface KeyEventLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

const MAC_KEYS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Backspace: '⌫',
  Delete: '⌦',
  ' ': 'Space',
  Enter: '↩',
};
const PC_KEYS: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space' };
const ACCELERATOR_KEYS: Record<string, string> = {
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ' ': 'Space',
  Enter: 'Return',
};

/**
 * The shortcut as the system writes it, as one string: "⇧⌘E" on macOS,
 * "Ctrl+Shift+E" on Windows and Linux. An empty string for no shortcut.
 */
export function formatShortcut(shortcut: Shortcut | null | undefined, platform: ShortcutPlatform): string {
  if (!shortcut) return '';
  if (platform === 'macos') {
    const key = MAC_KEYS[shortcut.key] ?? shortcut.key.toUpperCase();
    return `${shortcut.alt ? '⌥' : ''}${shortcut.shift ? '⇧' : ''}${shortcut.mod ? '⌘' : ''}${key}`;
  }
  const key = PC_KEYS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  return [...(shortcut.mod ? ['Ctrl'] : []), ...(shortcut.alt ? ['Alt'] : []), ...(shortcut.shift ? ['Shift'] : []), key].join('+');
}

/** The same chord for the `aria-keyshortcuts` attribute. Undefined for no shortcut. */
export function ariaKeyShortcuts(shortcut: Shortcut | null | undefined, platform: ShortcutPlatform): string | undefined {
  if (!shortcut) return undefined;
  const key = shortcut.key === ' ' ? 'Space' : shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key;
  return [...(shortcut.mod ? [platform === 'macos' ? 'Meta' : 'Control'] : []), ...(shortcut.alt ? ['Alt'] : []), ...(shortcut.shift ? ['Shift'] : []), key].join('+');
}

/**
 * True when the keyboard event is exactly this shortcut. Command (macOS) or Ctrl
 * (Windows and Linux) must be down for `mod` shortcuts and neither for the rest,
 * and Shift and Alt must match as well.
 */
export function matchesShortcut(event: KeyEventLike, shortcut: Shortcut | null | undefined, platform: ShortcutPlatform): boolean {
  if (!shortcut) return false;
  const mod = platform === 'macos' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  const noMod = !event.metaKey && !event.ctrlKey;
  return (
    (shortcut.mod ? mod : noMod) &&
    event.altKey === Boolean(shortcut.alt) &&
    event.shiftKey === Boolean(shortcut.shift) &&
    event.key.toLowerCase() === shortcut.key.toLowerCase()
  );
}

/** The shortcut in Electron's accelerator form, such as "Shift+Command+E". Null for no shortcut. */
export function toAccelerator(shortcut: Shortcut | null | undefined, platform: ShortcutPlatform = 'macos'): string | null {
  if (!shortcut) return null;
  const key = ACCELERATOR_KEYS[shortcut.key] ?? (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  const mod = platform === 'macos' ? 'Command' : 'Ctrl';
  return [...(shortcut.shift ? ['Shift'] : []), ...(shortcut.alt ? ['Alt'] : []), ...(shortcut.mod ? [mod] : []), key].join('+');
}

export interface Shortcuts<T extends string> {
  /** The command table passed in. */
  commands: Record<T, Shortcut | null>;
  platform: ShortcutPlatform;
  setPlatform(platform: ShortcutPlatform): void;
  /** Formatted label for a command, or an empty string when it has no shortcut. */
  label(command: T): string;
  ariaKeys(command: T): string | undefined;
  /** True when the event is the command's shortcut. */
  matches(event: KeyEventLike, command: T): boolean;
  /** The command whose shortcut the event is, or undefined. */
  find(event: KeyEventLike): T | undefined;
}

/** Bind a command table to a platform, for a renderer that looks shortcuts up by command id. */
export function createShortcuts<T extends string>(commands: Record<T, Shortcut | null>, initialPlatform: ShortcutPlatform = 'windows'): Shortcuts<T> {
  const entries = Object.entries(commands) as Array<[T, Shortcut | null]>;
  const bound: Shortcuts<T> = {
    commands,
    platform: initialPlatform,
    setPlatform(next) {
      bound.platform = next;
    },
    label: (command) => formatShortcut(commands[command], bound.platform),
    ariaKeys: (command) => ariaKeyShortcuts(commands[command], bound.platform),
    matches: (event, command) => matchesShortcut(event, commands[command], bound.platform),
    find: (event) => entries.find(([, shortcut]) => matchesShortcut(event, shortcut, bound.platform))?.[0],
  };
  return bound;
}
