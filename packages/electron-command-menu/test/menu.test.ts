import { describe, expect, it } from 'vitest';
import { createCommandMenu, DEFAULT_CHANNELS } from '../src/menu.js';
import type { CommandMenuConfig, InstallOptions, IpcEventLike, MenuItemLike, MenuLike, WindowLike } from '../src/menu.js';

interface FakeItem extends MenuItemLike {
  click?: (item: unknown, win: unknown, event?: { triggeredByAccelerator?: boolean }) => void;
}

function toMenu(template: any[]): MenuLike {
  return {
    items: template.map((entry): FakeItem => {
      const { submenu, ...rest } = entry;
      return { enabled: true, visible: true, ...rest, ...(submenu ? { submenu: toMenu(submenu) } : {}) };
    }),
  };
}

function flat(menu: MenuLike): FakeItem[] {
  return menu.items.flatMap((i) => [i, ...(i.submenu ? flat(i.submenu) : [])]) as FakeItem[];
}

function fakeElectron() {
  let appMenu: MenuLike | null = null;
  let dockMenu: MenuLike | null = null;
  const handlers = new Map<string, (event: IpcEventLike, ...args: any[]) => void>();
  return {
    Menu: {
      buildFromTemplate: toMenu,
      setApplicationMenu: (m: MenuLike | null) => void (appMenu = m),
      getApplicationMenu: () => appMenu,
    },
    app: { dock: { setMenu: (m: MenuLike) => void (dockMenu = m) } },
    ipcMain: { on: (channel: string, fn: (event: IpcEventLike, ...args: any[]) => void) => void handlers.set(channel, fn) },
    appMenu: () => appMenu,
    dockMenu: () => dockMenu,
    handlers,
  };
}

function fakeWindow(options: { focused?: boolean; loading?: boolean; textField?: boolean } = {}) {
  const sentMessages: Array<[string, unknown[]]> = [];
  const calls: string[] = [];
  const once = new Map<string, () => void>();
  const state = { destroyed: false, focused: options.focused ?? true, loading: options.loading ?? false, textField: options.textField ?? false };
  const win: WindowLike = {
    isDestroyed: () => state.destroyed,
    isFocused: () => state.focused,
    webContents: {
      id: 1,
      send: (channel, ...args) => void sentMessages.push([channel, args]),
      isLoading: () => state.loading,
      isFocused: () => state.focused,
      once: (event, fn) => void once.set(event, fn),
      executeJavaScript: async () => state.textField,
      undo: () => void calls.push('undo'),
      redo: () => void calls.push('redo'),
    },
  };
  return { win, state, sentMessages, calls, once };
}

const commands = {
  open: { key: 'o', mod: true },
  play: { key: ' ' },
  undo: { key: 'z', mod: true },
  redo: { key: 'z', mod: true, shift: true },
  about: null,
  grid: null,
};

function config(extra: Partial<CommandMenuConfig> = {}): CommandMenuConfig {
  return {
    commands,
    template: ({ productName, item }) => [
      { label: productName, submenu: [item('about', `About ${productName}`), { type: 'separator' }, { role: 'quit' }] },
      { label: 'File', submenu: [item('open', 'Open…')] },
      { label: 'Edit', submenu: [item('undo', 'Undo'), item('redo', 'Redo')] },
      { label: 'View', submenu: [item('grid', 'Show Grid', { type: 'checkbox' }), item('play', 'Play'), item('open', 'Open Again')] },
    ],
    dockTemplate: ({ item }) => [item('open', 'Open…')],
    workWithoutWindow: ['about'],
    readyFallbackMs: 10,
    ...extra,
  };
}

function setup(cfg: CommandMenuConfig = config(), windowOptions: Parameters<typeof fakeWindow>[0] = {}, install: Partial<InstallOptions> = {}) {
  const electron = fakeElectron();
  const w = fakeWindow(windowOptions);
  const holder = { win: w.win as WindowLike | null };
  const menu = createCommandMenu(cfg);
  menu.install({
    app: electron.app,
    Menu: electron.Menu,
    ipcMain: electron.ipcMain,
    productName: 'My App',
    getWindow: () => holder.win,
    ...install,
  });
  const items = () => flat(electron.appMenu()!);
  const find = (label: string) => items().find((i) => i.label === label)!;
  const heard = () => electron.handlers.get(DEFAULT_CHANNELS.state)!;
  return { menu, electron, w, holder, items, find, heard };
}

const click = (item: FakeItem, byKey = false) => item.click!(item, null, { triggeredByAccelerator: byKey });
const settle = () => new Promise((r) => setTimeout(r, 40));

describe('install', () => {
  it('builds the application menu from the template with accelerators from the command table', () => {
    const { find, electron } = setup();
    expect(electron.appMenu()!.items.map((i) => i.label)).toEqual(['My App', 'File', 'Edit', 'View']);
    expect(find('Open…').accelerator).toBe('Command+O');
    expect(find('Redo').accelerator).toBe('Shift+Command+Z');
    expect(find('Play').accelerator).toBe('Space');
    expect(find('About My App').accelerator).toBeUndefined();
  });

  it('uses the Windows accelerator spelling when asked', () => {
    const { find } = setup(config(), {}, { platform: 'windows' });
    expect(find('Open…').accelerator).toBe('Ctrl+O');
  });

  it('builds the dock menu', () => {
    const { electron } = setup();
    expect(electron.dockMenu()!.items.map((i) => i.label)).toEqual(['Open…']);
  });

  it('sets no application menu when menuBar is false and no dock menu when dockMenu is false', () => {
    const { electron } = setup(config(), {}, { menuBar: false, dockMenu: false });
    expect(electron.appMenu()).toBeNull();
    expect(electron.dockMenu()).toBeNull();
  });

  it('skips the dock menu when there is no dock', () => {
    const electron = fakeElectron();
    const menu = createCommandMenu(config());
    menu.install({ app: {}, Menu: electron.Menu, ipcMain: electron.ipcMain, productName: 'x', getWindow: () => null });
    expect(electron.dockMenu()).toBeNull();
  });

  it('describe() is null before install', () => {
    expect(createCommandMenu(config()).describe()).toBeNull();
  });
});

describe('routing commands', () => {
  it('sends a chosen command to the window once the page is listening', async () => {
    const { find, heard, w } = setup();
    const pending = (async () => click(find('Open…')))();
    heard()({ sender: w.win.webContents }, {});
    await pending;
    await settle();
    expect(w.sentMessages).toEqual([[DEFAULT_CHANNELS.command, ['open']]]);
  });

  it('falls back to sending after the page has loaded when it never reports state', async () => {
    const { find, w } = setup();
    click(find('Open…'));
    await settle();
    expect(w.sentMessages).toHaveLength(1);
  });

  it('waits for did-finish-load while the page is still loading', async () => {
    const { find, w } = setup(config(), { loading: true });
    click(find('Open…'));
    await settle();
    expect(w.sentMessages).toHaveLength(0);
    w.once.get('did-finish-load')!();
    await settle();
    expect(w.sentMessages).toHaveLength(1);
  });

  it('uses custom channel names', async () => {
    const { find, w } = setup(config({ channels: { command: 'my:cmd', state: 'my:state' } }));
    click(find('Open…'));
    await settle();
    expect(w.sentMessages[0][0]).toBe('my:cmd');
  });

  it('ignores an accelerator press while the page has keyboard focus', async () => {
    const { find, w } = setup();
    click(find('Open…'), true);
    await settle();
    expect(w.sentMessages).toHaveLength(0);
  });

  it('forwards an accelerator press when the page does not have focus', async () => {
    const { find, w } = setup(config(), { focused: false });
    click(find('Open…'), true);
    await settle();
    expect(w.sentMessages).toHaveLength(1);
  });

  it('does not send commands that need a window when there is none', async () => {
    const { find, holder, menu, w } = setup();
    holder.win = null;
    click(find('Open…'));
    await settle();
    expect(w.sentMessages).toHaveLength(0);
    expect(await menu.send('open')).toBe(false);
  });

  it('opens the window for a workWithoutWindow command', async () => {
    const created = fakeWindow();
    const electron = fakeElectron();
    const menu = createCommandMenu(config());
    const h = { win: null as WindowLike | null };
    menu.install({
      app: electron.app,
      Menu: electron.Menu,
      ipcMain: electron.ipcMain,
      productName: 'My App',
      getWindow: () => h.win,
      openWindow: () => (h.win = created.win),
    });
    expect(await menu.send('about')).toBe(true);
    expect(created.sentMessages).toEqual([[DEFAULT_CHANNELS.command, ['about']]]);
  });

  it('returns false when openWindow gives nothing, and before install', async () => {
    const electron = fakeElectron();
    const menu = createCommandMenu(config());
    expect(await menu.send('about')).toBe(false);
    menu.install({ app: electron.app, Menu: electron.Menu, ipcMain: electron.ipcMain, productName: 'x', getWindow: () => null, openWindow: () => null });
    expect(await menu.send('about')).toBe(false);
  });

  it('returns false when the window is destroyed while waiting', async () => {
    const { menu, w } = setup();
    const result = menu.send('open');
    w.state.destroyed = true;
    expect(await result).toBe(false);
  });
});

describe('page state', () => {
  it('disables commands the page reports as false', () => {
    const { find, menu, heard, w } = setup();
    heard()({ sender: w.win.webContents }, { open: false, play: true });
    expect(find('Open…').enabled).toBe(false);
    expect(find('Open Again').enabled).toBe(false);
    expect(find('Play').enabled).toBe(true);
    expect(find('Undo').enabled).toBe(true);
    menu.setState({});
    expect(find('Open…').enabled).toBe(true);
  });

  it('sets enabled and checked from an object state', () => {
    const { find, menu } = setup();
    menu.setState({ grid: { checked: true }, play: { enabled: false } });
    expect(find('Show Grid').checked).toBe(true);
    expect(find('Show Grid').enabled).toBe(true);
    expect(find('Play').enabled).toBe(false);
    menu.setState({ grid: { checked: false, enabled: false } });
    expect(find('Show Grid').checked).toBe(false);
    expect(find('Show Grid').enabled).toBe(false);
  });

  it('ignores malformed state', () => {
    const { find, menu } = setup();
    menu.setState({ open: false });
    menu.setState(null);
    menu.setState('nope');
    expect(find('Open…').enabled).toBe(false);
    menu.setState({ open: 'no', play: { enabled: 'x' }, grid: 5 });
    expect(find('Open…').enabled).toBe(true);
    expect(menu.describe()!.pageState).toEqual({});
  });

  it('ignores state messages that fail the trusted check', () => {
    const { find, heard, w } = setup(config(), {}, { trusted: () => false });
    heard()({ sender: w.win.webContents }, { open: false });
    expect(find('Open…').enabled).toBe(true);
    expect(w.sentMessages).toEqual([]);
  });

  it('with no window only workWithoutWindow commands are enabled', () => {
    const { find, holder, menu } = setup();
    holder.win = null;
    menu.windowChanged();
    expect(find('About My App').enabled).toBe(true);
    expect(find('Open…').enabled).toBe(false);
    expect(find('Play').enabled).toBe(false);
  });

  it('windowChanged restores enabled items when a window appears', () => {
    const { find, holder, menu, w } = setup();
    holder.win = null;
    menu.windowChanged();
    holder.win = w.win;
    menu.windowChanged();
    expect(find('Open…').enabled).toBe(true);
  });

  it('windowChanged clears the page state when the window goes away', () => {
    const { holder, menu } = setup();
    menu.setState({ open: false });
    holder.win = null;
    menu.windowChanged();
    expect(menu.describe()!.pageState).toEqual({});
  });
});

describe('undo and redo in text fields', () => {
  it('runs the field own undo and redo when a text field has focus', async () => {
    const { find, w } = setup(config(), { textField: true });
    click(find('Undo'));
    click(find('Redo'));
    await settle();
    expect(w.calls).toEqual(['undo', 'redo']);
    expect(w.sentMessages).toHaveLength(0);
  });

  it('sends the command to the page when no text field has focus', async () => {
    const { find, w } = setup(config(), { textField: false });
    click(find('Undo'));
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.sentMessages).toEqual([[DEFAULT_CHANNELS.command, ['undo']]]);
  });

  it('can be turned off', async () => {
    const { find, w } = setup(config({ textFieldUndoRedo: null }), { textField: true });
    click(find('Undo'));
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.sentMessages).toHaveLength(1);
  });

  it('treats a failing text-field check as no text field', async () => {
    const { find, w } = setup(config(), { textField: true });
    w.win.webContents.executeJavaScript = async () => {
      throw new Error('gone');
    };
    click(find('Undo'));
    await settle();
    expect(w.calls).toEqual([]);
    expect(w.sentMessages).toHaveLength(1);
  });
});

describe('describe', () => {
  it('lists the menu, dock, state and counters', async () => {
    const { menu, heard, w } = setup();
    heard()({ sender: w.win.webContents }, { open: false });
    await menu.send('play');
    const d = menu.describe()!;
    expect(d.pageListening).toBe(true);
    expect(d.commandsSent).toBe(1);
    expect(d.dockMenu).toEqual([{ label: 'Open…', command: 'open', enabled: false }]);
    const file = d.applicationMenu!.find((e) => e.label === 'File')!;
    expect(file.submenu![0]).toMatchObject({ label: 'Open…', command: 'open', accelerator: 'Command+O', enabled: false });
    const app = d.applicationMenu![0];
    expect(app.submenu![1]).toEqual({ separator: true });
    expect(app.submenu![2]).toMatchObject({ role: 'quit' });
  });

  it('reports pageListening false before the page has said anything', () => {
    const { menu } = setup();
    expect(menu.describe()!.pageListening).toBe(false);
    expect(menu.describe()!.dockMenu).not.toBeNull();
  });
});
