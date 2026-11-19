import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { startProcess } from '../src/index.js';

const node = process.execPath;
const posix = process.platform !== 'win32';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('startProcess with a real process', () => {
  it('streams stdout and reports a clean exit', async () => {
    const chunks: string[] = [];
    const run = startProcess({ command: node, args: ['-e', "process.stdout.write('hello'); process.exit(0)"], onStdout: (c) => chunks.push(c.toString()) });
    const outcome = await run.done;
    expect(chunks.join('')).toBe('hello');
    expect(outcome.exitCode).toBe(0);
    expect(outcome.exitSignal).toBeNull();
    expect(outcome.spawnError).toBeNull();
    expect(outcome.stopReason).toBeNull();
    expect(outcome.escalated).toBe(false);
    expect(outcome.pid).toBe(run.pid);
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a non-zero exit code and the stderr tail', async () => {
    const run = startProcess({ command: node, args: ['-e', "console.error('bad thing'); process.exit(3)"] });
    const outcome = await run.done;
    expect(outcome.exitCode).toBe(3);
    expect(outcome.stderrTail).toContain('bad thing');
    expect(outcome.stderrTruncated).toBe(false);
  });

  it('keeps only the last stderrTailBytes of stderr', async () => {
    const run = startProcess({
      command: node,
      args: ['-e', "process.stderr.write('a'.repeat(500)); setTimeout(() => process.stderr.write('END'), 50); setTimeout(() => process.exit(0), 150)"],
      stderrTailBytes: 100,
    });
    const outcome = await run.done;
    expect(outcome.stderrTruncated).toBe(true);
    expect(Buffer.byteLength(outcome.stderrTail)).toBeLessThanOrEqual(100);
    expect(outcome.stderrTail.endsWith('END')).toBe(true);
  });

  it('forwards stderr chunks to onStderr', async () => {
    const seen: string[] = [];
    const run = startProcess({ command: node, args: ['-e', "console.error('x')"], onStderr: (c) => seen.push(c.toString()) });
    await run.done;
    expect(seen.join('')).toContain('x');
  });

  it('keeps draining when a consumer throws', async () => {
    const run = startProcess({
      command: node,
      args: ['-e', "process.stdout.write('1'); setTimeout(() => process.stdout.write('2'), 30)"],
      onStdout: () => {
        throw new Error('consumer fault');
      },
    });
    const outcome = await run.done;
    expect(outcome.exitCode).toBe(0);
  });

  it('resolves with spawnError when the command does not exist', async () => {
    const run = startProcess({ command: 'definitely-not-a-real-command-xyz' });
    const outcome = await run.done;
    expect(outcome.spawnError).toMatch(/ENOENT/);
    expect(outcome.exitCode).toBeNull();
    expect(run.pid).toBeNull();
  });

  it('removes ELECTRON_RUN_AS_NODE and other listed variables from the environment', async () => {
    const out: string[] = [];
    const run = startProcess({
      command: node,
      args: ['-e', 'process.stdout.write(JSON.stringify([process.env.ELECTRON_RUN_AS_NODE ?? null, process.env.SECRET_X ?? null, process.env.KEEP_ME ?? null]))'],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', SECRET_X: 's', KEEP_ME: 'k' },
      removeEnv: ['ELECTRON_RUN_AS_NODE', 'SECRET_X'],
      onStdout: (c) => out.push(c.toString()),
    });
    await run.done;
    expect(JSON.parse(out.join(''))).toEqual([null, null, 'k']);
  });

  it('stop() closes stdin so a tool that reads it can finish before the grace period', async () => {
    const run = startProcess({
      command: node,
      args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(7))"],
      graceMs: 5000,
    });
    run.stop('user cancelled');
    const outcome = await run.done;
    expect(outcome.exitCode).toBe(7);
    expect(outcome.stopReason).toBe('user cancelled');
    expect(outcome.escalated).toBe(false);
  });

  it('stop() kills a tool that ignores stdin once the grace period is over', async () => {
    const run = startProcess({ command: node, args: ['-e', 'setInterval(() => {}, 1000)'], graceMs: 150 });
    run.stop('timeout');
    const outcome = await run.done;
    expect(outcome.escalated).toBe(true);
    expect(outcome.stopReason).toBe('timeout');
    if (posix) expect(outcome.exitSignal).toBe('SIGKILL');
  });

  it('stop() with its own graceMs overrides the default', async () => {
    const run = startProcess({ command: node, args: ['-e', 'setInterval(() => {}, 1000)'], graceMs: 60000 });
    run.stop('quick', 100);
    const outcome = await run.done;
    expect(outcome.escalated).toBe(true);
  });

  it('keeps the first stop reason', async () => {
    const run = startProcess({ command: node, args: ['-e', 'setInterval(() => {}, 1000)'], graceMs: 100 });
    run.stop('first');
    run.stop('second');
    const outcome = await run.done;
    expect(outcome.stopReason).toBe('first');
  });

  it('closeStdinOnStop false leaves stdin open until the kill', async () => {
    const run = startProcess({
      command: node,
      args: ['-e', "process.stdin.resume(); process.stdin.on('end', () => process.exit(7))"],
      graceMs: 200,
      closeStdinOnStop: false,
    });
    run.stop('x');
    const outcome = await run.done;
    expect(outcome.escalated).toBe(true);
    expect(outcome.exitCode).not.toBe(7);
  });

  it('kill() ends the process at once and records why', async () => {
    const run = startProcess({ command: node, args: ['-e', 'setInterval(() => {}, 1000)'] });
    run.kill();
    const outcome = await run.done;
    expect(outcome.stopReason).toBe('killed');
    expect(outcome.escalated).toBe(true);
    expect(outcome.exitCode === null || outcome.exitCode !== 0).toBe(true);
  });

  it('stop and kill after the run has finished do nothing', async () => {
    const run = startProcess({ command: node, args: ['-e', ''] });
    const outcome = await run.done;
    run.stop('late');
    run.kill();
    run.sweep();
    expect(outcome.stopReason).toBeNull();
  });

  it.skipIf(!posix)('kill() takes the whole process tree', async () => {
    const out: string[] = [];
    const run = startProcess({
      command: node,
      args: [
        '-e',
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write('G' + c.pid + '\\n'); setInterval(() => {}, 1000)",
      ],
      onStdout: (c) => out.push(c.toString()),
    });
    await waitFor(() => /G\d+\n/.test(out.join('')));
    const grandchild = Number(/G(\d+)/.exec(out.join(''))![1]);
    try {
      expect(alive(grandchild)).toBe(true);
      run.kill();
      await run.done;
      await waitFor(() => !alive(grandchild));
    } finally {
      if (alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    }
  });

  it.skipIf(!posix)('sweep() removes processes left in the group after the leader exited', async () => {
    const out: string[] = [];
    const run = startProcess({
      command: node,
      args: [
        '-e',
        "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); process.stdout.write('G' + c.pid + '\\n'); process.exit(0)",
      ],
      onStdout: (c) => out.push(c.toString()),
    });
    await run.done;
    const grandchild = Number(/G(\d+)/.exec(out.join(''))![1]);
    try {
      expect(alive(grandchild)).toBe(true);
      run.sweep();
      await waitFor(() => !alive(grandchild));
    } finally {
      if (alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    }
  });
});

interface FakeChild extends EventEmitter {
  pid: number | undefined;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: string[];
  kill(signal?: string): boolean;
  unref(): void;
}

function fakeChild(pid: number | undefined = 4242): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = pid;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = [];
  child.kill = (signal?: string) => {
    child.killed.push(signal ?? 'SIGTERM');
    return true;
  };
  child.unref = () => {};
  return child;
}

describe('startProcess with an injected spawn', () => {
  it('passes spawn options: no shell, hidden window, detached on macOS and Linux only', () => {
    const calls: Array<{ command: string; options: Record<string, unknown> }> = [];
    for (const platform of ['darwin', 'win32'] as const) {
      startProcess({
        command: 'tool',
        args: ['--flag'],
        cwd: '/work',
        platform,
        spawn: (command, _args, options) => {
          calls.push({ command, options: options as Record<string, unknown> });
          return fakeChild() as unknown as ChildProcess;
        },
      });
    }
    expect(calls[0].options).toMatchObject({ shell: false, windowsHide: true, detached: true, cwd: '/work' });
    expect(calls[1].options).toMatchObject({ shell: false, windowsHide: true, detached: false });
  });

  it('kills the process group on macOS and Linux', async () => {
    const child = fakeChild(900);
    const signals: Array<[number, string]> = [];
    const run = startProcess({ command: 'tool', platform: 'linux', spawn: () => child as unknown as ChildProcess, signalProcess: (pid, signal) => signals.push([pid, signal]) });
    run.kill();
    expect(signals).toEqual([[-900, 'SIGKILL']]);
    child.emit('exit', null, 'SIGKILL');
    child.emit('close');
    const outcome = await run.done;
    expect(outcome.exitSignal).toBe('SIGKILL');
  });

  it('falls back to a direct kill when the group signal fails', () => {
    const child = fakeChild(901);
    const run = startProcess({
      command: 'tool',
      platform: 'darwin',
      spawn: () => child as unknown as ChildProcess,
      signalProcess: () => {
        throw new Error('ESRCH');
      },
    });
    run.kill();
    expect(child.killed).toEqual(['SIGKILL']);
  });

  it('kills the tree on Windows with taskkill', () => {
    const child = fakeChild(777);
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const run = startProcess({
      command: 'tool.exe',
      platform: 'win32',
      spawn: (command, args) => {
        spawned.push({ command, args });
        return (command === 'tool.exe' ? child : fakeChild(1)) as unknown as ChildProcess;
      },
    });
    run.kill();
    expect(spawned[1]).toEqual({ command: 'taskkill', args: ['/PID', '777', '/T', '/F'] });
  });

  it('uses child.kill on Windows when taskkill cannot start', async () => {
    const child = fakeChild(778);
    const run = startProcess({
      command: 'tool.exe',
      platform: 'win32',
      spawn: (command) => {
        if (command === 'taskkill') {
          const killer = fakeChild(2);
          queueMicrotask(() => killer.emit('error', new Error('ENOENT')));
          return killer as unknown as ChildProcess;
        }
        return child as unknown as ChildProcess;
      },
    });
    run.kill();
    await new Promise((r) => setTimeout(r, 10));
    expect(child.killed).toEqual(['SIGTERM']);
  });

  it('settles after drainMs when the pipes never close', async () => {
    const child = fakeChild(1000);
    const run = startProcess({ command: 'tool', platform: 'linux', drainMs: 30, spawn: () => child as unknown as ChildProcess });
    child.emit('exit', 0, null);
    const outcome = await run.done;
    expect(outcome.exitCode).toBe(0);
  });

  it('resolves with a spawn error when spawn throws', async () => {
    const run = startProcess({
      command: 'tool',
      spawn: () => {
        throw new Error('EACCES');
      },
    });
    expect((await run.done).spawnError).toBe('EACCES');
  });
});
