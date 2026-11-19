# @uppercut-labs/electron-command-menu

Builds an Electron application menu and Dock menu from one list of commands, sends the chosen command to the focused window, and keeps menu items enabled, disabled or checked to match what the page reports. It also formats and matches keyboard shortcuts for Windows and macOS. The shortcut helpers have no Electron or Node imports and work in a renderer.

Every Electron object (`Menu`, `app`, `ipcMain`, the window) is passed in, so the logic runs under plain Node in tests.

```sh
npm install @uppercut-labs/electron-command-menu
```

Main process:

```ts
import { app, BrowserWindow, Menu, ipcMain } from 'electron';
import { createCommandMenu } from '@uppercut-labs/electron-command-menu';

const menu = createCommandMenu({
  commands: {
    open: { key: 'o', mod: true },
    'toggle-grid': { key: 'g', mod: true },
    about: null,
  },
  template: ({ productName, item }) => [
    { label: productName, submenu: [item('about', `About ${productName}`), { role: 'quit' }] },
    { label: 'File', submenu: [item('open', 'Open…')] },
    { label: 'View', submenu: [item('toggle-grid', 'Show Grid', { type: 'checkbox' })] },
  ],
  dockTemplate: ({ item }) => [item('open', 'Open…')],
  workWithoutWindow: ['about'],
});

app.whenReady().then(() => {
  menu.install({
    app,
    Menu,
    ipcMain,
    productName: 'My App',
    getWindow: () => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null,
    openWindow: createMainWindow,
    trusted: (event) => event.senderFrame?.url.startsWith('app://') ?? false,
  });
});
```

Preload script, which exposes the two channels to the page:

```ts
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('commandMenu', {
  onCommand: (fn: (command: string) => void) => ipcRenderer.on('command-menu:command', (_e, command) => fn(command)),
  setState: (state: Record<string, boolean | { enabled?: boolean; checked?: boolean }>) => ipcRenderer.send('command-menu:state', state),
});
```

Page: run the command in `onCommand`, and call `setState({ open: false, 'toggle-grid': { checked: true } })` whenever availability changes. Commands the page does not name stay enabled. The first state message tells the main process the page is listening; until then commands wait, with a short fallback after the page finishes loading.

## createCommandMenu(config)

| Option | Default | Meaning |
| --- | --- | --- |
| `commands` | required | Shortcut per command id, `null` for none. Used for menu accelerators |
| `template(context)` | required | Application menu entries. `context.item(command, label, extra?)` makes a command item with its accelerator |
| `dockTemplate(context)` | none | Dock menu entries, each with `command` and `label` |
| `workWithoutWindow` | none | Command ids that still work with no window; `openWindow` is called to receive them |
| `channels` | `command-menu:command`, `command-menu:state` | IPC channel names |
| `textFieldUndoRedo` | `{ undo: 'undo', redo: 'redo' }` | Commands that run the text field's own undo and redo when one has focus; `null` turns it off |
| `readyFallbackMs` | `1500` | Wait after load for a page that never sends state |

Returned object:

| Method | Does |
| --- | --- |
| `install(options)` | Sets the application menu, the Dock menu and the state listener. Call once after the app is ready |
| `setState(state)` | Replaces the page state directly |
| `windowChanged()` | Call when the window is created or closed |
| `send(command)` | Sends a command as if its item was chosen; resolves `true` when sent |
| `describe()` | The menu, Dock menu, page state and counters, for diagnostics |

`install` options: `app`, `Menu`, `ipcMain`, `productName`, `getWindow`, `openWindow`, `trusted(event)`, `menuBar` (default `true`; `false` sets no menu), `dockMenu` (default `true`), `platform` (`'macos'` default, or `'windows'` for accelerator spelling).

A menu item fired by its accelerator while the page has keyboard focus is ignored, because the page's own shortcut handling already ran. It is forwarded when chosen with the pointer, or when the page does not have focus.

## Shortcut helpers

Import from `@uppercut-labs/electron-command-menu/shortcuts` in a renderer.

| Function | Returns |
| --- | --- |
| `formatShortcut(shortcut, platform)` | `Ctrl+Shift+E` on `'windows'`, `⇧⌘E` on `'macos'` |
| `ariaKeyShortcuts(shortcut, platform)` | Value for `aria-keyshortcuts`, or `undefined` |
| `matchesShortcut(event, shortcut, platform)` | `true` when the keyboard event is exactly that shortcut |
| `toAccelerator(shortcut, platform?)` | Electron accelerator such as `Shift+Command+E` |
| `createShortcuts(commands, platform?)` | Object with `label`, `ariaKeys`, `matches`, `find` and `setPlatform`, keyed by command id |

A `Shortcut` is `{ key, mod?, shift?, alt? }`. `key` is a `KeyboardEvent.key` value. `mod` is Ctrl on Windows and Linux and Command on macOS.

## License

MIT
