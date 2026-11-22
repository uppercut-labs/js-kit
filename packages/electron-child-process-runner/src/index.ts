import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';

/** Result of a run, resolved by `done` once the process and its pipes are finished. */
export interface Outcome {
  /** Message when the process could not be started, otherwise null. */
  spawnError: string | null;
  exitCode: number | null;
  exitSignal: string | null;
  /** The last `stderrTailBytes` bytes of stderr, decoded as UTF-8. */
  stderrTail: string;
  /** True when earlier stderr output was dropped to keep the tail bounded. */
  stderrTruncated: boolean;
  /** Why `stop` or `kill` was first called, or null if neither was. */
  stopReason: string | null;
  /** True when the process was killed, either because the grace period ran out or `kill` was called. */
  escalated: boolean;
  durationMs: number;
  pid: number | null;
}

export type SpawnFunction = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;

export interface StartProcessOptions {
  /** Executable to run. No shell is involved. */
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Environment for the child. Defaults to the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Variables removed from the child's environment. Default: `ELECTRON_RUN_AS_NODE`. */
  removeEnv?: readonly string[];
  /** Platform to behave as. Default: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Time between closing stdin and killing the process, in milliseconds. Default 3000. */
  graceMs?: number;
  /** Bytes of stderr kept for the outcome. Default 16384. */
  stderrTailBytes?: number;
  /** Time to wait for the pipes to end after the process exits, in milliseconds. Default 500. */
  drainMs?: number;
  /** Called with every stdout chunk. An exception thrown here is ignored. */
  onStdout?: (chunk: Buffer) => void;
  /** Called with every stderr chunk. An exception thrown here is ignored. */
  onStderr?: (chunk: Buffer) => void;
  /** Close stdin when `stop` is called, which tools read as a cancel request. Default true. */
  closeStdinOnStop?: boolean;
  /** Replaces `child_process.spawn`. Used by tests, and by apps that wrap spawning. */
  spawn?: SpawnFunction;
  /** Replaces `process.kill`, used to signal a process group on macOS and Linux. */
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
}

export interface RunningProcess {
  pid: number | null;
  /** Resolves, never rejects, when the process has exited or could not start. */
  done: Promise<Outcome>;
  /** Ask the process to finish: close stdin, then kill after the grace period. */
  stop(reason: string, graceMs?: number): void;
  /** Kill the process tree now. */
  kill(): void;
  /** Kill anything left in the process group (macOS and Linux; no effect on Windows). */
  sweep(): void;
}

export const DEFAULT_STDERR_TAIL_BYTES = 16 * 1024;
export const DEFAULT_GRACE_MS = 3000;
export const DEFAULT_DRAIN_MS = 500;

function messageOf(error: unknown): string {
  return String((error as { message?: unknown } | null)?.message ?? error);
}

export function startProcess(options: StartProcessOptions): RunningProcess {
  const platform = options.platform ?? process.platform;
  const graceMs = options.graceMs ?? DEFAULT_GRACE_MS;
  const tailLimit = options.stderrTailBytes ?? DEFAULT_STDERR_TAIL_BYTES;
  const drainMs = options.drainMs ?? DEFAULT_DRAIN_MS;
  const spawnFn = options.spawn ?? nodeSpawn;
  const signalProcess = options.signalProcess ?? ((pid, signal) => process.kill(pid, signal));
  const closeStdinOnStop = options.closeStdinOnStop ?? true;
  const started = Date.now();

  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env) };
  for (const name of options.removeEnv ?? ['ELECTRON_RUN_AS_NODE']) delete env[name];

  const outcome: Outcome = {
    spawnError: null,
    exitCode: null,
    exitSignal: null,
    stderrTail: '',
    stderrTruncated: false,
    stopReason: null,
    escalated: false,
    durationMs: 0,
    pid: null,
  };
  let resolveDone!: (value: Outcome) => void;
  const done = new Promise<Outcome>((resolve) => {
    resolveDone = resolve;
  });

  let child: ChildProcess;
  try {
    child = spawnFn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      // On macOS and Linux the child leads its own group so the whole tree can be signalled.
      detached: platform !== 'win32',
    });
  } catch (error) {
    outcome.spawnError = messageOf(error);
    resolveDone(outcome);
    return { pid: null, done, stop() {}, kill() {}, sweep() {} };
  }
  outcome.pid = child.pid ?? null;

  let exited = false;
  let settled = false;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let drainTimer: ReturnType<typeof setTimeout> | null = null;
  let tail: Buffer[] = [];
  let tailBytes = 0;

  child.stdin?.on('error', () => {}); // the tool may be gone before stdin is closed
  child.stdout?.on('data', (chunk: Buffer) => {
    try {
      options.onStdout?.(chunk);
    } catch {
      // A consumer fault must not stop the drain.
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    try {
      options.onStderr?.(chunk);
    } catch {
      // A consumer fault must not stop the drain.
    }
    tail.push(chunk);
    tailBytes += chunk.length;
    while (tail.length > 1 && tailBytes - tail[0].length >= tailLimit) {
      tailBytes -= tail[0].length;
      tail.shift();
      outcome.stderrTruncated = true;
    }
  });
  child.stdout?.on('error', () => {});
  child.stderr?.on('error', () => {});

  function killTree(): void {
    if (exited) return;
    const pid = child.pid;
    if (pid === undefined) return;
    if (platform === 'win32') {
      try {
        const killer = spawnFn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        killer.on?.('error', () => {
          try {
            child.kill();
          } catch {
            // Already gone.
          }
        });
        killer.unref?.();
      } catch {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
      return;
    }
    try {
      signalProcess(-pid, 'SIGKILL');
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }

  function stop(reason: string, grace: number = graceMs): void {
    if (settled || exited) return;
    if (outcome.stopReason === null) outcome.stopReason = reason;
    if (closeStdinOnStop) {
      try {
        child.stdin?.end();
      } catch {
        // Already closed.
      }
    }
    if (graceTimer) return;
    graceTimer = setTimeout(() => {
      outcome.escalated = true;
      killTree();
    }, grace);
  }

  function kill(): void {
    if (settled || exited) return;
    if (outcome.stopReason === null) outcome.stopReason = 'killed';
    outcome.escalated = true;
    killTree();
  }

  function sweep(): void {
    if (platform === 'win32' || !child.pid) return;
    try {
      signalProcess(-child.pid, 'SIGKILL');
    } catch {
      // The group is already empty.
    }
  }

  function settle(): void {
    if (settled) return;
    settled = true;
    if (graceTimer) clearTimeout(graceTimer);
    if (drainTimer) clearTimeout(drainTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.stdin?.destroy();
    const joined = Buffer.concat(tail);
    const kept = joined.length > tailLimit ? joined.subarray(joined.length - tailLimit) : joined;
    if (kept.length < joined.length) outcome.stderrTruncated = true;
    outcome.stderrTail = kept.toString('utf8');
    tail = [];
    outcome.durationMs = Date.now() - started;
    resolveDone(outcome);
  }

  child.on('error', (error) => {
    // Either the process never started, or a signal could not be delivered.
    if (child.pid === undefined) {
      outcome.spawnError = messageOf(error);
      settle();
    }
  });
  child.on('exit', (code, signal) => {
    exited = true;
    outcome.exitCode = code;
    outcome.exitSignal = signal;
    if (graceTimer) clearTimeout(graceTimer);
    // 'close' waits for the pipes. A stray process holding them must not hold us.
    drainTimer = setTimeout(settle, drainMs);
  });
  child.on('close', settle);

  return { pid: child.pid ?? null, done, stop, kill, sweep };
}

export { createLineReader } from './lines.js';
export type { LineReader, LineReaderOptions } from './lines.js';
