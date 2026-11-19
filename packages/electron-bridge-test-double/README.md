# @uppercut-labs/electron-bridge-test-double

Building blocks for a fake preload bridge, so an Electron renderer can run in a plain browser. It provides a call log, event emitters, a menu hook, fixture selection from the page address, storage that never throws, and cancellable timers. The methods of the bridge itself are yours to write; this package supplies the parts every fake needs.

```sh
npm install --save-dev @uppercut-labs/electron-bridge-test-double
```

```ts
import { createBridgeHarness, installBridgeIfMissing, instrument } from '@uppercut-labs/electron-bridge-test-double';

function createFakeBridge() {
  const h = createBridgeHarness<{ files: string[] }>({
    storagePrefix: 'my-app',
    fixtures: { table: { default: { files: ['a.txt'] }, empty: { files: [] } }, fallback: 'default' },
  });
  const progress = h.channel<number>('progress');
  const saved = h.storage.load();

  return instrument(
    {
      async bootstrap() {
        return { stored: saved, files: h.fixture.data!.files };
      },
      saveState(key: string, json: string) {
        h.storage.save(key, json);
      },
      onProgress: (listener: (n: number) => void) => progress.add(listener),
      onMenuCommand: (listener: (id: string) => void) => h.menuCommands.add(listener),
      setMenuState: (enabled: Record<string, boolean>) => h.menu.setMenuState(enabled),
    },
    h.log,
    { saveState: (args) => [args[0]] },
  );
}

// Uses the fake only when the real preload bridge is missing.
export const desktop = installBridgeIfMissing(createFakeBridge);
```

Open the page as `index.html#fixture=empty&platform=macos` to pick a scenario. Scripts and tests can read `window.__desktopCalls` and `window.__menuState`, and call `window.__menuCommand('file.open')` as the application menu would.

## Functions

| Function | Meaning |
| --- | --- |
| `createEmitter<T>()` | `{ add(listener) => remove, emit(value), size, clear() }`. A listener that throws does not stop the others; the first error is rethrown after all have run |
| `createCallLog(options?)` | `{ calls, record(name, ...args), callsTo(name), clear() }`. Publishes `calls` as `window.__desktopCalls`; `exposeAs` renames it or turns it off with `null`, `target` changes the object |
| `instrument(implementation, log, selectArgs?)` | Returns a copy of the implementation in which every function records its call first. `selectArgs` maps a method name to a function that picks the arguments to log |
| `installMenuHook(emitter, options?)` | Sets `window.__menuCommand(id)` to emit on `emitter` and returns `{ command, setMenuState }`, which stores the state on `window.__menuState`. `commandKey`, `stateKey` and `target` are options |
| `parseHashParams(source?)` | Search params from `#a=1&b=2`, a URL or a query. Default source is `location.hash` |
| `readOption(name, allowed, fallback, source?)` | The address option when it is in `allowed`, otherwise `fallback` |
| `defineFixtures(table, fallback)` | `{ names, has(name), get(name), select(source?, param?) }`. A table value is data (cloned on every use) or a function that builds it. `select` reads `fixture=` and falls back for a missing or unknown name |
| `createPrefixedStorage(prefix, storage?)` | `{ load(), save(key, json), memory }` over `localStorage` or the storage you pass. `load` returns entries whose key starts with `<prefix>.`. Read and write failures are swallowed and values stay in `memory` |
| `createScheduler(timers?)` | `{ after(ms, fn) => cancel, wait(ms), cancelAll(), pending }`. `wait` resolves `true` when the time passes and `false` when cancelled. Pass your own `setTimeout` and `clearTimeout` to control time |
| `wait(ms)` | A promise that resolves after `ms` |
| `createBridgeHarness(options)` | Creates a call log, menu hook, `menuCommands` emitter, storage, scheduler, selected `fixture`, `option(name, allowed, fallback)` and `channel(name)` for named emitters. Options: `storagePrefix`, `fixtures`, `address`, `target`, `storage` |
| `installBridgeIfMissing(create, options?)` | Sets `window.desktop` to `create()` only when it is undefined and returns the bridge in place. `name` and `target` are options |

## Errors

`defineFixtures` throws when `fallback` is not a key of the table, and `get` throws for an unknown name. Nothing else throws on its own; failures in storage are swallowed on purpose.

## License

MIT
