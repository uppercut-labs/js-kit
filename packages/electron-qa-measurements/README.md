# @uppercut-labs/electron-qa-measurements

Measures how an Electron window behaves under input: the time from a key event to the frame that shows its effect while typing into a field, the time to open a command palette, launch and first-frame times, and whether typed text survives a kill and relaunch. Every timing is reported with sample count, p50, p95 and max. The package reports numbers and does not decide what is acceptable.

The window is passed in, and only a few `BrowserWindow` and `webContents` methods are used, so the statistics and scenarios also run against a stand-in object in tests. Electron is an optional peer dependency and is never imported.

```sh
npm install @uppercut-labs/electron-qa-measurements
```

```ts
import { app, BrowserWindow, screen } from 'electron';
import { generateText, measureCommandPalette, measureLaunchMarks, measureTyping, writeJsonReport } from '@uppercut-labs/electron-qa-measurements';

const launchedAt = Date.now();

async function runQa(win: BrowserWindow) {
  const marks = await measureLaunchMarks(win, {
    launchedAt,
    getDisplay: (bounds) => {
      const d = screen.getDisplayMatching(bounds!);
      return { hz: d.displayFrequency, scale: d.scaleFactor };
    },
  });
  const typing = await measureTyping(win, { field: '#search', text: generateText(220) });
  const palette = await measureCommandPalette(win, { openSelector: '.palette' });
  await writeJsonReport('qa-report.json', { marks, typing, palette });
  app.quit();
}
```

## Statistics and text

| Function | Returns |
| --- | --- |
| `computeStats(values)` | `{ samples, p50, p95, max }` using nearest-rank percentiles, rounded to 0.1 ms; `{ samples: 0 }` for no data. Values that are not finite are ignored |
| `generateText(count, kind?)` | Deterministic text of exactly `count` characters; `kind` is `'prose'` (default) or `'digits'` (digits, `.`, `+`, `-`) |

## Scenarios

Each scenario takes the window first. All accept `sleep` and `injector` options so they can run without real time or real input.

| Function | What it does |
| --- | --- |
| `measureTyping(win, options)` | Focuses the field, installs a page-side probe, types `text` and returns `{ latency, typed, fieldLengthAfter, interactionsOverThreshold, worstEventTimingMs, focused }`. `latency` runs from each key event's timestamp to the end of the frame that rendered the change |
| `measureCommandPalette(win, options)` | Presses the shortcut `runs` times and returns `{ open, samples, runs, missed }`. `open` runs from the key event to the frame in which `openSelector` matches |
| `measureLaunchMarks(win, options)` | Returns launch-to-load and launch-to-first-frame times, first contentful paint, optional display details and the result of an optional page-side `benchScript` |
| `typeAndRecord(win, options)` | Types into the field and returns `{ pid, expected, typed, lastKeyAt }` for an outside script to use when it kills the process |
| `checkRecovery(record, restoredText)` | Compares the text found after relaunch with the record: `exact`, `typedSurvived`, lengths, `commonPrefixLength` and `lostChars` |
| `readField(win, field)` | The text in the field, or `null` when no element matches |
| `reloadPage(win)` | Reloads and resolves on `did-finish-load` |

Options for `measureTyping`: `field` (CSS selector), `text`, `gapMs` (35), `settleMs` (400), `slowThresholdMs` (16, the platform minimum).

Every scenario that types also takes `focusWindow`. The default `sendInputEvent` injector needs the window focused, so without an `injector` the window is focused first; with an injector (such as `createProtocolInjector` with `emulatePageFocus`) it is not, because on macOS focusing the web contents makes the window the key window and takes the user's focus. Set `focusWindow` to override either default. Changed in 0.1.1: 0.1.0 always focused the window.

Options for `measureCommandPalette`: `openSelector`, `key` (`k`), `modifier` (`meta` on macOS, `control` elsewhere), `runs` (6), `closeKey` (`Escape`), `settleMs` (300), `closeMs` (250).

Options for `measureLaunchMarks`: `launchedAt` (epoch ms, required), `now`, `getDisplay(bounds)`, `benchScript`. Call it from the `did-finish-load` handler; `didFinishLoad` is the time it was called.

Options for `typeAndRecord`: `field`, `text`, `pid` (current process), `gapMs` (25), `now`.

A kill-and-relaunch check has three steps. In the first run, call `typeAndRecord` and write the record to a file. From outside, terminate the process by its `pid`. In the second run, call `readField` after the app has restored its state and pass the text to `checkRecovery` with the saved record.

## Key injection

By default keys go through `webContents.sendInputEvent`. Pass `injector` to use something else.

| Function | Meaning |
| --- | --- |
| `createInputEventInjector(webContents)` | The default: `keyDown`, `char` and `keyUp` events |
| `createProtocolInjector(send)` | Keys through the DevTools protocol (`Input.dispatchKeyEvent`), where `send` is `(method, params) => webContents.debugger.sendCommand(method, params)`; the window never needs focus |
| `emulatePageFocus(send)` | Makes the page behave as focused while its window is not, for use with the protocol injector |
| `modifierForPlatform(platform?)` | `'meta'` for `darwin` or `macos`, otherwise `'control'` |

A `KeyInjector` is `{ press(key, modifiers?) }`, and may be asynchronous.

## Reports and arguments

| Function | Meaning |
| --- | --- |
| `writeJsonReport(file, value)` | Writes indented JSON, creating folders, and returns the absolute path |
| `describeWindow(win)` | `{ bounds, visible, focused }` for whatever the window can answer |
| `readArg(name, argv?)` | The value of `--name=value`, or `null` |
| `createLatencyProbeScript(field, options?)` and other `*Script` exports | The page-side scripts, if you want to run them yourself |

## Errors

`measureTyping` and `typeAndRecord` throw `Error('No element matches <selector>')` when the field is missing. `reloadPage` rejects when the window has no `reload` or `once`. `generateText` throws `RangeError` for a count that is not a non-negative integer. `measureLaunchMarks` does not throw for page errors; it stores them as `paintError` and `benchError`.

## License

MIT
