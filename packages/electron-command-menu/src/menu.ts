import { toAccelerator } from './shortcuts.js';
import type { Shortcut, ShortcutPlatform } from './shortcuts.js';

// ---- the parts of Electron that are used, so tests can pass fakes ----------

export interface WebContentsLike {
  id: number;
  send(channel: string, ...args: unknown[]): void;
  isLoading(): boolean;
  isFocused(): boolean;
  once(event: string, listener: () => void): unknown;
  executeJavaScript(code: string): Promise<unknown>;
  undo(): void;
  redo(): void;
}

export interface WindowLike {
  isDestroyed(): boolean;
  isFocused(): boolean;
  webContents: WebContentsLike;
}

export interface MenuItemLike {
  id?: string;
  label?: string;
  role?: string;
  type?: string;
  accelerator?: string | null;
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  submenu?: MenuLike | null;
}

export interface MenuLike {
  items: MenuItemLike[];
}

export interface MenuStatic {
  buildFromTemplate(template: any[]): MenuLike;
  setApplicationMenu(menu: MenuLike | null): void;
  getApplicationMenu(): MenuLike | null;
}

export interface IpcEventLike {
  sender: WebContentsLike;
}

export interface IpcMainLike {
  on(channel: string, listener: (event: IpcEventLike, ...args: any[]) => void): unknown;
}

export interface AppLike {
  dock?: { setMenu(menu: MenuLike): void } | null;
}

// ---- options ---------------------------------------------------------------

/** A menu entry in a template. `command` makes the item send that command id to the page. */
export interface TemplateEntry {
  command?: string;
  label?: string;
  role?: string;
  type?: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu';
  accelerator?: string;
  checked?: boolean;
  enabled?: boolean;
  visible?: boolean;
  submenu?: TemplateEntry[];
  [key: string]: unknown;
}

/** State the page reports for a command: false disables it, or an object sets either part. */
export type CommandState = boolean | { enabled?: boolean; checked?: boolean };
export type PageState = Record<string, CommandState>;

export interface CommandMenuChannels {
  /** Main to page: the id of the command that was chosen. */
  command: string;
  /** Page to main: the state of the commands. */
  state: string;
}

export const DEFAULT_CHANNELS: CommandMenuChannels = { command: 'command-menu:command', state: 'command-menu:state' };

export interface TemplateContext {
  productName: string;
  /** A command item: `{ command, label, accelerator }` with the accelerator taken from the command table. */
  item(command: string, label: string, extra?: Partial<TemplateEntry>): TemplateEntry;
}

export interface CommandMenuConfig {
  /** Shortcut per command id; null or a missing id means no accelerator. */
  commands: Record<string, Shortcut | null>;
  /** The application menu. */
  template(context: TemplateContext): TemplateEntry[];
  /** The macOS Dock menu. Items need `command` and `label`. */
  dockTemplate?(context: TemplateContext): TemplateEntry[];
  /** Commands that still work with no window open; the window is created to receive them. Default: none. */
  workWithoutWindow?: Iterable<string>;
  channels?: Partial<CommandMenuChannels>;
  /**
   * Ids of the undo and redo commands. When one is chosen while a text field in the focused
   * window has focus, the field's own undo or redo runs instead of the page's command. Needed
   * on macOS, where a text field can only undo through the menu. Default `{ undo: 'undo', redo: 'redo' }`; null turns it off.
   */
  textFieldUndoRedo?: { undo: string; redo: string } | null;
  /** Milliseconds to wait for a page that never sends state before sending it a command. Default 1500. */
  readyFallbackMs?: number;
}

export interface InstallOptions {
  app: AppLike;
  Menu: MenuStatic;
  ipcMain: IpcMainLike;
  productName: string;
  /** Return the window commands go to, or null. Called on every command. */
  getWindow(): WindowLike | null | undefined;
  /** Create the window for a `workWithoutWindow` command. */
  openWindow?(): WindowLike | null | undefined;
  /** Accept or reject a state message by its IPC event. Default: accept all. */
  trusted?(event: IpcEventLike): boolean;
  /** Set a menu bar. Default true; false sets no application menu (a menu bar on Windows and Linux draws inside the window). */
  menuBar?: boolean;
  /** Set the Dock menu when `app.dock` exists. Default true. */
  dockMenu?: boolean;
  /** Which accelerator spelling to use. Default 'macos'. */
  platform?: ShortcutPlatform;
}

export interface MenuDescription {
  applicationMenu: DescribedEntry[] | null;
  dockMenu: Array<{ label?: string; command: string; enabled: boolean }> | null;
  pageState: PageState;
  pageListening: boolean;
  commandsSent: number;
}

export interface DescribedEntry {
  separator?: true;
  label?: string;
  role?: string;
  command?: string;
  accelerator?: string;
  enabled?: boolean;
  visible?: boolean;
  checked?: boolean;
  submenu?: DescribedEntry[];
}

export interface CommandMenu {
  install(options: InstallOptions): void;
  /** Replace the page state: which commands can run and which are checked. Commands not named can run. */
  setState(state: unknown): void;
  /** Call when the window is created or closed. */
  windowChanged(): void;
  /** Send a command to the window as if its menu item was chosen; resolves true when it was sent. */
  send(command: string): Promise<boolean>;
  /** The menu as the system has it now, for diagnostics. Null before `install`. */
  describe(): MenuDescription | null;
}

interface ReadyEntry {
  promise: Promise<void>;
  resolve: () => void;
  heard: boolean;
  waiting: boolean;
}

interface Context extends InstallOptions {
  menuBar: boolean;
  dockMenu: boolean;
  platform: ShortcutPlatform;
}

const TEXT_FIELD_CHECK =
  "(() => { const el = document.activeElement; return !!el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(button|checkbox|radio|range|submit|reset|file|color)$/.test(el.type))); })()";

export function createCommandMenu(config: CommandMenuConfig): CommandMenu {
  const channels: CommandMenuChannels = { ...DEFAULT_CHANNELS, ...config.channels };
  const workWithoutWindow = new Set(config.workWithoutWindow ?? []);
  const textUndoRedo = config.textFieldUndoRedo === undefined ? { undo: 'undo', redo: 'redo' } : config.textFieldUndoRedo;
  const readyFallbackMs = config.readyFallbackMs ?? 1500;

  let ctx: Context | null = null;
  let pageState: PageState = {};
  const itemsByCommand = new Map<string, MenuItemLike[]>();
  const commandOfId = new Map<string, string>();
  const ready = new Map<number, ReadyEntry>();
  let sent = 0;
  let idCounter = 0;

  function liveWindow(): WindowLike | null {
    const win = ctx?.getWindow();
    return win && !win.isDestroyed() ? win : null;
  }

  function enabledFor(command: string): boolean {
    if (!liveWindow()) return workWithoutWindow.has(command);
    const state = pageState[command];
    if (state === undefined) return true;
    if (typeof state === 'boolean') return state;
    return state.enabled !== false;
  }

  function refresh(): void {
    for (const [command, items] of itemsByCommand) {
      const state = pageState[command];
      const checked = typeof state === 'object' && state !== null ? state.checked : undefined;
      for (const entry of items) {
        entry.enabled = enabledFor(command);
        if (checked !== undefined) entry.checked = checked;
      }
    }
  }

  function listening(contents: WebContentsLike): ReadyEntry {
    let entry = ready.get(contents.id);
    if (!entry) {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => (resolve = r));
      entry = { promise, resolve, heard: false, waiting: false };
      ready.set(contents.id, entry);
      contents.once('destroyed', () => {
        ready.delete(contents.id);
        resolve();
      });
    }
    return entry;
  }

  /** Resolves when the page can receive a command: at its first state message, or a moment after it loads. */
  function whenListening(win: WindowLike): Promise<void> {
    const contents = win.webContents;
    const entry = listening(contents);
    if (!entry.waiting) {
      entry.waiting = true;
      const fallback = () => void setTimeout(entry.resolve, readyFallbackMs);
      if (contents.isLoading()) contents.once('did-finish-load', fallback);
      else fallback();
    }
    return entry.promise;
  }

  async function send(command: string): Promise<boolean> {
    if (!ctx) return false;
    let win = liveWindow();
    if (!win) {
      if (!workWithoutWindow.has(command)) return false;
      win = ctx.openWindow?.() ?? null;
      if (!win) return false;
    }
    await whenListening(win);
    if (win.isDestroyed()) return false;
    win.webContents.send(channels.command, command);
    sent += 1;
    return true;
  }

  async function inTextField(win: WindowLike): Promise<boolean> {
    try {
      return Boolean(await win.webContents.executeJavaScript(TEXT_FIELD_CHECK));
    } catch {
      return false;
    }
  }

  /**
   * A menu item was chosen. `byKey` is true when its accelerator fired it. The page's own
   * shortcut handling already ran for a key pressed while the page had focus, so that case is
   * ignored here to keep the command from running twice.
   */
  async function chosen(command: string, byKey: boolean): Promise<void> {
    const win = liveWindow();
    const pageHasKeys = Boolean(win && win.isFocused() && win.webContents.isFocused());
    if (textUndoRedo && (command === textUndoRedo.undo || command === textUndoRedo.redo) && win && pageHasKeys && (await inTextField(win))) {
      if (command === textUndoRedo.undo) win.webContents.undo();
      else win.webContents.redo();
      return;
    }
    if (byKey && pageHasKeys) return;
    await send(command);
  }

  function context(productName: string, platform: ShortcutPlatform): TemplateContext {
    return {
      productName,
      item(command, label, extra = {}) {
        const accelerator = toAccelerator(config.commands[command], platform);
        return { command, label, ...(accelerator ? { accelerator } : {}), ...extra };
      },
    };
  }

  function build(Menu: MenuStatic, entries: TemplateEntry[]): MenuLike {
    const withClicks = (list: TemplateEntry[]): TemplateEntry[] =>
      list.map((entry) => {
        if (entry.submenu) return { ...entry, submenu: withClicks(entry.submenu) };
        if (!entry.command) return entry;
        const { command, ...rest } = entry;
        const id = `command-menu:${(idCounter += 1)}`;
        commandOfId.set(id, command);
        return {
          ...rest,
          id,
          click: (_item: unknown, _window: unknown, event?: { triggeredByAccelerator?: boolean }) => void chosen(command, Boolean(event?.triggeredByAccelerator)),
        };
      });
    const menu = Menu.buildFromTemplate(withClicks(entries));
    const collect = (m: MenuLike): void => {
      for (const entry of m.items) {
        if (entry.submenu) collect(entry.submenu);
        const command = entry.id ? commandOfId.get(entry.id) : undefined;
        if (command !== undefined) {
          const list = itemsByCommand.get(command) ?? [];
          list.push(entry);
          itemsByCommand.set(command, list);
        }
      }
    };
    collect(menu);
    return menu;
  }

  function setState(state: unknown): void {
    if (!state || typeof state !== 'object') return;
    const next: PageState = {};
    for (const [command, value] of Object.entries(state as Record<string, unknown>)) {
      if (typeof value === 'boolean') next[command] = value;
      else if (value && typeof value === 'object') {
        const { enabled, checked } = value as { enabled?: unknown; checked?: unknown };
        const part: { enabled?: boolean; checked?: boolean } = {};
        if (typeof enabled === 'boolean') part.enabled = enabled;
        if (typeof checked === 'boolean') part.checked = checked;
        if (Object.keys(part).length > 0) next[command] = part;
      }
    }
    pageState = next;
    refresh();
  }

  function install(options: InstallOptions): void {
    const platform = options.platform ?? 'macos';
    ctx = { ...options, menuBar: options.menuBar ?? true, dockMenu: options.dockMenu ?? true, platform };
    itemsByCommand.clear();
    commandOfId.clear();
    pageState = {};
    const tc = context(options.productName, platform);
    if (ctx.menuBar) options.Menu.setApplicationMenu(build(options.Menu, config.template(tc)));
    else options.Menu.setApplicationMenu(null);
    if (ctx.dockMenu && options.app.dock && config.dockTemplate) options.app.dock.setMenu(build(options.Menu, config.dockTemplate(tc)));

    const trusted = options.trusted ?? (() => true);
    options.ipcMain.on(channels.state, (event, state) => {
      if (!trusted(event)) return;
      const entry = listening(event.sender);
      entry.heard = true;
      entry.resolve();
      setState(state);
    });
    refresh();
  }

  function windowChanged(): void {
    const win = liveWindow();
    if (win) void whenListening(win);
    else pageState = {};
    refresh();
  }

  function describeMenu(menu: MenuLike): DescribedEntry[] {
    return menu.items.map((entry) => {
      const command = entry.id ? commandOfId.get(entry.id) : undefined;
      const out: DescribedEntry = entry.type === 'separator' ? { separator: true } : { label: entry.label };
      if (entry.role) out.role = entry.role;
      if (command !== undefined) out.command = command;
      if (entry.accelerator) out.accelerator = entry.accelerator;
      if (entry.type !== 'separator') {
        out.enabled = entry.enabled;
        out.visible = entry.visible;
        if (entry.checked !== undefined) out.checked = entry.checked;
      }
      if (entry.submenu) out.submenu = describeMenu(entry.submenu);
      return out;
    });
  }

  function describe(): MenuDescription | null {
    if (!ctx) return null;
    const menu = ctx.Menu.getApplicationMenu();
    const win = liveWindow();
    const dock =
      ctx.dockMenu && ctx.app.dock && config.dockTemplate
        ? config
            .dockTemplate(context(ctx.productName, ctx.platform))
            .filter((entry) => entry.command)
            .map((entry) => ({ label: entry.label, command: entry.command as string, enabled: enabledFor(entry.command as string) }))
        : null;
    return {
      applicationMenu: menu ? describeMenu(menu) : null,
      dockMenu: dock,
      pageState,
      pageListening: Boolean(win && ready.get(win.webContents.id)?.heard),
      commandsSent: sent,
    };
  }

  return { install, setState, windowChanged, send, describe };
}
