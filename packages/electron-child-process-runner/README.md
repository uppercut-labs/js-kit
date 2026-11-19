# @uppercut-labs/electron-child-process-runner

Starts a child tool from a main process and owns its lifetime. It streams stdout, keeps a bounded tail of stderr, closes stdin as a cancel request and kills the process tree if the tool is still running after a grace period. A `done` promise resolves with the exit code, signal, stderr tail and timing.

It does not need Electron. It only uses `node:child_process`, so it works in any Node program. It is written for Electron main processes, and it removes `ELECTRON_RUN_AS_NODE` from the child's environment by default.

```sh
npm install @uppercut-labs/electron-child-process-runner
```

```ts
import { startProcess } from '@uppercut-labs/electron-child-process-runner';

const run = startProcess({
  command: '/usr/local/bin/my-tool',
  args: ['--input', 'file.dat'],
  cwd: '/tmp/work',
  graceMs: 3000,
  onStdout: (chunk) => parseProgress(chunk),
});

// Later, from a Cancel button:
run.stop('user cancelled');

const outcome = await run.done;
if (outcome.spawnError) console.error('could not start:', outcome.spawnError);
else console.log(outcome.exitCode, outcome.stopReason, outcome.stderrTail);
```

## startProcess(options)

| Option | Default | Meaning |
| --- | --- | --- |
| `command` | required | Executable to run. No shell is used |
| `args` | `[]` | Argument array |
| `cwd` | current directory | Working directory |
| `env` | `process.env` | Environment for the child |
| `removeEnv` | `['ELECTRON_RUN_AS_NODE']` | Variables removed from the child's environment |
| `platform` | `process.platform` | Platform to behave as |
| `graceMs` | `3000` | Time from `stop` to kill, in milliseconds |
| `stderrTailBytes` | `16384` | Bytes of stderr kept for the outcome |
| `drainMs` | `500` | Wait for the pipes to end after the process exits |
| `onStdout`, `onStderr` | none | Called with each `Buffer` chunk. An exception thrown here is ignored |
| `closeStdinOnStop` | `true` | Whether `stop` closes stdin |
| `spawn`, `signalProcess` | Node's | Replacements for `child_process.spawn` and `process.kill`, for tests |

## Returned object

| Member | Meaning |
| --- | --- |
| `pid` | Process id, or `null` if it did not start |
| `done` | `Promise<Outcome>`; never rejects |
| `stop(reason, graceMs?)` | Closes stdin, then kills after the grace period. The first reason is kept |
| `kill()` | Kills the process tree now |
| `sweep()` | Kills anything left in the process group after the process exited (macOS and Linux) |

`Outcome` has `spawnError`, `exitCode`, `exitSignal`, `stderrTail`, `stderrTruncated`, `stopReason`, `escalated` (the process was killed rather than ending itself), `durationMs` and `pid`.

## Process tree

On macOS and Linux the child is started detached as a group leader, and a kill sends `SIGKILL` to the whole group. On Windows a kill runs `taskkill /PID <pid> /T /F`, and falls back to `child.kill()` if `taskkill` cannot start.

## License

MIT
