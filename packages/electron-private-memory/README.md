# @uppercut-labs/electron-private-memory

Measures the private memory of a running Electron app, summed over its processes, by the definition that fits each system, and compares it with a budget and a ceiling. These are the definitions Chromium uses for its own "private footprint":

| System | Definition | Scope |
| --- | --- | --- |
| Windows | private bytes | the processes Electron started (`app.getAppMetrics()`) |
| macOS | `phys_footprint`, read with `/usr/bin/footprint` | the process tree under the root |
| Linux | anonymous resident memory plus swap (`Anonymous` + `Swap` in `/proc/<pid>/smaps_rollup`) | the process tree under the root |

Electron is never imported. Reading processes and running programs go through options, so every path can run under test on any system.

```sh
npm install @uppercut-labs/electron-private-memory
```

```ts
import { app } from 'electron';
import { measureMemory } from '@uppercut-labs/electron-private-memory';

const report = await measureMemory({ getAppMetrics: () => app.getAppMetrics(), budgetMB: 300, ceilingMB: 680 });
console.log(`${report.privateMB} MB over ${report.processes} processes (${report.definition})`);
if (!report.underCeiling) process.exitCode = 1;
```

## measureMemory(options)

| Option | Default | Meaning |
| --- | --- | --- |
| `system` | from `process.platform` | `'windows'`, `'macos'` or `'linux'` |
| `root` | `process.pid` | the process whose tree is measured (macOS, Linux) |
| `getAppMetrics` | none | Electron's `app.getAppMetrics`; required on Windows |
| `budgetMB`, `ceilingMB` | `300`, `680` | limits for `withinBudget` and `underCeiling` |
| `run(file, args)` | `execFile`, 15 s limit | runs `ps` and `footprint` on macOS |
| `readFile(file)`, `listProc()` | `fs` | read `/proc` on Linux |
| `now()` | `new Date()` | the clock for `at` |

The report: `at`, `system`, `definition`, `scope`, `root`, `processes`, `privateMB` (rounded to 0.1), `budgetMB`, `ceilingMB`, `withinBudget`, `underCeiling`, `detail` (one `{ pid, name, privateMB, residentMB?, unreadable? }` per process) and `error` when the system's reading failed. On macOS the total is `footprint`'s own summary; elsewhere it is the sum of `detail`.

On Windows, programs the app starts itself (a bundled tool) are not in Electron's list; measure them from outside. A Linux process that ends or cannot be read is listed with `unreadable` and 0 MB rather than dropped. Calling this from an Electron main process is cheap on Windows and Linux; on macOS it starts `ps` and `footprint`.

## Helpers

| Function | Returns |
| --- | --- |
| `descendants(root, pairs)` | the root's id and every descendant's, from `[pid, parent]` pairs |
| `parsePs(text)` | `ps -axo pid=,ppid=` output as pairs |
| `parseFootprint(text)` | `{ detail, totalBytes }` from `footprint -f bytes --noCategories` |
| `smapsValue(rollup, key)` | one kB value from `smaps_rollup`, 0 when absent |
| `systemOf(platform?)` | the system name for a Node platform |

## License

MIT
