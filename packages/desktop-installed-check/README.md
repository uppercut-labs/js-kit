# @uppercut-labs/desktop-installed-check

Checks an installed desktop app on macOS and Linux through files and the app's own control channel, never through input events, so it takes no focus and types nothing. It is one POSIX shell script with seven steps, plus a small Node wrapper that runs a step and reads the verdict.

```sh
npm install --save-dev @uppercut-labs/desktop-installed-check
```

## What the script checks

| Step | What it does |
| --- | --- |
| `list` | What is installed: files, bundled helpers, notices. On macOS the code signature and hardened-runtime flag of the bundle and of every helper, entitlements, Gatekeeper and quarantine. On Linux the package, the sandbox helper's owner and mode, the desktop entry, icons, shared libraries and the AppArmor profile |
| `helpers` | Runs every bundled helper from its installed location, started by the installed app's own executable acting as Node (`ELECTRON_RUN_AS_NODE=1`) with `PATH` emptied |
| `launch` | Starts the app from its real launcher: `open` on the bundle (macOS) or the command line in the installed desktop entry (Linux) |
| `collect` | Asks the running app, through its control channel and never through a second launch, for its diagnostics and a picture of its window |
| `memory` | Private memory over the app's processes, by each system's definition: `footprint` on macOS, `Anonymous` plus `Swap` from `smaps_rollup` on Linux |
| `quit` | Asks the running app to close |
| `uninstall` | Removes the installed copy and never the data folder |

Every line goes to the terminal and to `<EVIDENCE>/installed-<step>.txt`. The script exits 1 when any line starts with `FAILED:`, and 0 otherwise. An unknown step is a failure.

## Use

The script reads the names of the app from a file, which your packaging step writes:

```sh
# out/package.env
PRODUCT_NAME="Example App"
EXE_NAME=example
LINUX_NAME=example
APP_ID=com.example.app
VERSION=1.2.3
HELPERS="ffmpeg ffprobe"
```

```sh
PACKAGE_ENV=out/package.env EVIDENCE=qa/evidence DATA_DIR=/tmp/app-data NO_ACTIVATE=1 \
  sh node_modules/@uppercut-labs/desktop-installed-check/scripts/installed-check.sh list
```

| Variable | Meaning |
| --- | --- |
| `PACKAGE_ENV` | The names file above (default `out/package.env`). `HELPERS` is the bundled helper programs separated by spaces, and may be empty |
| `EVIDENCE` | Where result files go (default `qa/evidence`). On macOS keep it and `DATA_DIR` on the internal disk: an app started by `open` that touches a removable or network volume waits for a privacy prompt that nobody answers |
| `DATA_DIR` | The app's data folder. `collect` and `quit` find the running app's control channel through `control.json` there, so they require it |
| `APP_SCRIPTS` | The folder holding the app's own `control.cjs`, `installed-helpers.cjs` and `installed-diagnostics.cjs` (default: the folder of the script) |
| `INSTALL_TO` | macOS: the Applications folder (default `~/Applications`). Linux portable: the folder it was unpacked into (default `~/.local/opt`) |
| `KIND` | Linux: `deb` (default) or `portable` |
| `NO_ACTIVATE=1` | `launch` without taking focus, so the app serves its control channel |
| `EMPTY_PATH=1` | `launch` with `PATH` emptied, to prove nothing is looked up there |
| `LAUNCH_EXTRA` | `launch` only: more arguments, separated by spaces, such as `--remote-debugging-port=9333 --mute-audio` |
| `BUDGET_MB`, `CEILING_MB` | The `memory` step's limits, `300` and `680` by default. Over the budget is a note; over the ceiling is a failure |

The `collect`, `helpers` and `quit` steps call scripts that belong to the app: `control.cjs` (a client of [`@uppercut-labs/electron-control-channel`](../electron-control-channel)), `installed-helpers.cjs` and `installed-diagnostics.cjs`, found in `APP_SCRIPTS`. `list`, `launch`, `memory` and `uninstall` need none of them.

## From Node

```ts
import { runInstalledCheck } from '@uppercut-labs/desktop-installed-check';

const run = await runInstalledCheck('list', { packageEnv: 'out/package.env', evidenceDir: 'qa/evidence' });
if (!run.report.passed) console.error(run.report.failed);
```

| Export | Meaning |
| --- | --- |
| `installedCheckScript` | Absolute path of the script. `require.resolve('@uppercut-labs/desktop-installed-check/installed-check.sh')` gives the same file |
| `runInstalledCheck(step, options)` | Runs one step with `sh` and returns `{ step, exitCode, output, report }`. Options map to the variables above: `packageEnv`, `evidenceDir`, `appScripts`, `dataDir`, `installTo`, `kind`, `noActivate`, `emptyPath`, `launchExtra`, `budgetMb`, `ceilingMb`, `env`, `timeoutMs`, `shell` |
| `parseInstalledCheckOutput(text)` | Reads a step's text into `{ failed, finished, passed, overBudget, memory? }`. `finished` is true only when the script reached its last line, so a killed script does not pass |
| `installedCheckEnvironment(options)` | The environment `runInstalledCheck` builds |
| `INSTALLED_CHECK_STEPS` | The step names |

## Not covered

There is no Windows version. Run the Node wrapper on macOS or Linux only; it starts `sh`.

## License

MIT
