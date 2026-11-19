import { describe, expect, it } from 'vitest';
import { ariaKeyShortcuts, createShortcuts, formatShortcut, matchesShortcut, toAccelerator } from '../src/shortcuts.js';

function ev(key: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) {
  return { key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...mods };
}

describe('formatShortcut', () => {
  it('writes Windows labels with plus signs', () => {
    expect(formatShortcut({ key: 'e', mod: true, shift: true }, 'windows')).toBe('Ctrl+Shift+E');
    expect(formatShortcut({ key: 'k', mod: true, alt: true }, 'windows')).toBe('Ctrl+Alt+K');
    expect(formatShortcut({ key: 'ArrowUp', alt: true }, 'windows')).toBe('Alt+↑');
    expect(formatShortcut({ key: ' ' }, 'windows')).toBe('Space');
    expect(formatShortcut({ key: 'F5' }, 'windows')).toBe('F5');
  });

  it('writes macOS glyphs in the system order', () => {
    expect(formatShortcut({ key: 'e', mod: true, shift: true }, 'macos')).toBe('⇧⌘E');
    expect(formatShortcut({ key: 'k', mod: true, alt: true, shift: true }, 'macos')).toBe('⌥⇧⌘K');
    expect(formatShortcut({ key: 'Backspace' }, 'macos')).toBe('⌫');
    expect(formatShortcut({ key: 'Enter', mod: true }, 'macos')).toBe('⌘↩');
    expect(formatShortcut({ key: 'ArrowLeft', mod: true }, 'macos')).toBe('⌘←');
  });

  it('returns an empty string for no shortcut', () => {
    expect(formatShortcut(null, 'macos')).toBe('');
    expect(formatShortcut(undefined, 'windows')).toBe('');
  });
});

describe('ariaKeyShortcuts', () => {
  it('uses Control on Windows and Meta on macOS', () => {
    expect(ariaKeyShortcuts({ key: 'e', mod: true, shift: true }, 'windows')).toBe('Control+Shift+E');
    expect(ariaKeyShortcuts({ key: 'e', mod: true, shift: true }, 'macos')).toBe('Meta+Shift+E');
    expect(ariaKeyShortcuts({ key: ' ' }, 'windows')).toBe('Space');
    expect(ariaKeyShortcuts({ key: 'ArrowDown', alt: true }, 'macos')).toBe('Alt+ArrowDown');
  });

  it('returns undefined for no shortcut', () => {
    expect(ariaKeyShortcuts(null, 'windows')).toBeUndefined();
  });
});

describe('matchesShortcut', () => {
  const save = { key: 's', mod: true };

  it('needs Ctrl on Windows and Command on macOS for mod shortcuts', () => {
    expect(matchesShortcut(ev('s', { ctrlKey: true }), save, 'windows')).toBe(true);
    expect(matchesShortcut(ev('s', { metaKey: true }), save, 'windows')).toBe(false);
    expect(matchesShortcut(ev('s', { metaKey: true }), save, 'macos')).toBe(true);
    expect(matchesShortcut(ev('s', { ctrlKey: true }), save, 'macos')).toBe(false);
  });

  it('rejects both Ctrl and Command together', () => {
    expect(matchesShortcut(ev('s', { ctrlKey: true, metaKey: true }), save, 'windows')).toBe(false);
    expect(matchesShortcut(ev('s', { ctrlKey: true, metaKey: true }), save, 'macos')).toBe(false);
  });

  it('matches the key without regard to case, and shift and alt exactly', () => {
    expect(matchesShortcut(ev('S', { ctrlKey: true }), save, 'windows')).toBe(true);
    expect(matchesShortcut(ev('s', { ctrlKey: true, shiftKey: true }), save, 'windows')).toBe(false);
    expect(matchesShortcut(ev('s', { ctrlKey: true, altKey: true }), save, 'windows')).toBe(false);
    expect(matchesShortcut(ev('s', { ctrlKey: true, shiftKey: true }), { key: 's', mod: true, shift: true }, 'windows')).toBe(true);
  });

  it('matches shortcuts with no modifier only when none is down', () => {
    expect(matchesShortcut(ev(' '), { key: ' ' }, 'windows')).toBe(true);
    expect(matchesShortcut(ev(' ', { ctrlKey: true }), { key: ' ' }, 'windows')).toBe(false);
    expect(matchesShortcut(ev(' ', { metaKey: true }), { key: ' ' }, 'macos')).toBe(false);
  });

  it('never matches a null shortcut', () => {
    expect(matchesShortcut(ev('s'), null, 'windows')).toBe(false);
  });
});

describe('toAccelerator', () => {
  it('writes Electron accelerators with Command for macOS and Ctrl for Windows', () => {
    expect(toAccelerator({ key: 'e', mod: true, shift: true })).toBe('Shift+Command+E');
    expect(toAccelerator({ key: 'e', mod: true, shift: true }, 'windows')).toBe('Shift+Ctrl+E');
    expect(toAccelerator({ key: 'ArrowUp', alt: true })).toBe('Alt+Up');
    expect(toAccelerator({ key: ' ' })).toBe('Space');
    expect(toAccelerator({ key: 'Enter', mod: true })).toBe('Command+Return');
    expect(toAccelerator({ key: ',', mod: true })).toBe('Command+,');
    expect(toAccelerator({ key: 'Home' })).toBe('Home');
    expect(toAccelerator(null)).toBeNull();
  });
});

describe('createShortcuts', () => {
  const table = { save: { key: 's', mod: true }, play: { key: ' ' }, none: null };

  it('labels and matches by command id on the current platform', () => {
    const shortcuts = createShortcuts(table);
    expect(shortcuts.label('save')).toBe('Ctrl+S');
    expect(shortcuts.ariaKeys('save')).toBe('Control+S');
    expect(shortcuts.matches(ev('s', { ctrlKey: true }), 'save')).toBe(true);
    shortcuts.setPlatform('macos');
    expect(shortcuts.platform).toBe('macos');
    expect(shortcuts.label('save')).toBe('⌘S');
    expect(shortcuts.matches(ev('s', { ctrlKey: true }), 'save')).toBe(false);
    expect(shortcuts.matches(ev('s', { metaKey: true }), 'save')).toBe(true);
  });

  it('handles commands without a shortcut', () => {
    const shortcuts = createShortcuts(table, 'macos');
    expect(shortcuts.label('none')).toBe('');
    expect(shortcuts.ariaKeys('none')).toBeUndefined();
    expect(shortcuts.matches(ev('x'), 'none')).toBe(false);
  });

  it('finds the command for an event', () => {
    const shortcuts = createShortcuts(table);
    expect(shortcuts.find(ev(' '))).toBe('play');
    expect(shortcuts.find(ev('s', { ctrlKey: true }))).toBe('save');
    expect(shortcuts.find(ev('q'))).toBeUndefined();
  });
});
