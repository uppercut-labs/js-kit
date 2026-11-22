// A control channel between scripts and a running Electron app, so a script never starts a
// second instance of the app to talk to it.
//
// Why: a second launch of an Electron app's executable reaches the running app through
// Chromium's process singleton. On Windows the second process calls
// AllowSetForegroundWindow(<running app's pid>) before it sends its command line, so when the
// second launch was started by a process that holds the right to set the foreground (anything
// Explorer starts), the running app's window can come to the front before any app code runs.
// A person who opens the app again expects that; a test script asking for diagnostics does not.
// Requests through this channel (a named pipe on Windows, a Unix socket elsewhere) grant nothing.
//
// Protocol: one request per connection, one line of JSON each way.
//   request  {"v":1,"argv":["--diagnostics=C:\\x.json"],"cwd":"C:\\"}
//   reply    {"v":1,"ok":true,"handled":true,"files":0,"ms":412}
//            {"v":1,"ok":false,"error":"..."}
//
// Plain Node, no Electron: the client runs in scripts, in the app's own executable acting as
// Node, and in the app before it decides what kind of launch it is. It never asks which system
// it is on; callers pass `system`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const VERSION = 1;
const INFO_FILE = 'control.json';
const MAX_REQUEST = 64 * 1024;

/** The system, as the caller names it. Only 'windows' changes anything: a pipe instead of a socket. */
export type System = 'windows' | 'macos' | 'linux';

/**
 * Flags that only mean "do this in the running app". A launch carrying one never becomes an
 * instance of the app and never uses the process singleton: it goes through the channel or not
 * at all. A flag that ends in `=` takes a value. Apps add their own with `commandFlags`.
 */
export const DEFAULT_COMMAND_FLAGS: readonly string[] = ['diagnostics=', 'capture=', 'show-about', 'quit', 'close-window', 'menu-command=', 'full-screen=', 'qa-press=', 'qa-menu-state='];

export interface FlagOptions {
  /** The command flags, without `--`. Default DEFAULT_COMMAND_FLAGS. */
  commandFlags?: readonly string[];
}

const flagName = (arg: string) => (arg.startsWith('--') ? arg.slice(2) : null);

/** Whether one argument is a command flag. */
export function isCommandFlag(arg: string, { commandFlags = DEFAULT_COMMAND_FLAGS }: FlagOptions = {}): boolean {
  const name = flagName(arg);
  return name !== null && commandFlags.some((f) => (f.endsWith('=') ? name.startsWith(f) : name === f));
}

export type LaunchKind = 'command' | 'agent' | 'person';

/**
 * What kind of launch an argument list is (argv[0] is the executable and is skipped).
 *   command  carries a command flag: send it through the channel, never become an instance
 *   agent    a script's launch (--no-activate, --control or any --qa-* flag) without a command:
 *            hand it to a running app that answers on the channel, otherwise become the app
 *   person   anything else: the normal path, including a second launch that brings the window forward
 */
export function classify(argv: readonly string[], options: FlagOptions = {}): LaunchKind {
  const args = argv.slice(1);
  if (args.some((a) => isCommandFlag(a, options))) return 'command';
  if (args.some((a) => a === '--no-activate' || a === '--control' || a.startsWith('--qa-'))) return 'agent';
  return 'person';
}

/** Whether a first launch serves the channel: only a script's launch (--no-activate or --control). */
export function serves(argv: readonly string[]): boolean {
  return argv.includes('--no-activate') || argv.includes('--control');
}

/** A name for the pipe or socket: lower case letters, digits and dashes; "app" when empty. */
export const slug = (name: string | undefined): string =>
  String(name || 'app')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'app';

/**
 * Where the channel of the app with this data folder listens. `name` is the app's own name
 * (its executable name, for example), so two apps never share a pipe. On Windows a named pipe
 * keyed by the data folder (case-insensitive); elsewhere a socket in the data folder, or in /tmp
 * when that path would pass the Unix socket limit (104 bytes on macOS, 108 on Linux).
 */
export function endpoint(userData: string, system: System, name = 'app'): string {
  const safe = slug(name);
  const id = crypto
    .createHash('sha256')
    .update(system === 'windows' ? userData.toLowerCase() : userData)
    .digest('hex')
    .slice(0, 16);
  if (system === 'windows') return `\\\\.\\pipe\\${safe}-control-${id}`;
  const inside = path.posix.join(userData, 'control.sock');
  return Buffer.byteLength(inside) <= 100 ? inside : path.posix.join('/tmp', `${safe}-control-${id}.sock`);
}

/** The file in the data folder that says where the running app listens. */
export const infoPath = (userData: string): string => path.join(userData, INFO_FILE);

export interface Info {
  v: number;
  endpoint: string;
  pid?: number;
}

/** What control.json says, or null when there is none or it is not this version's. */
export function readInfo(userData: string): Info | null {
  try {
    const info: unknown = JSON.parse(fs.readFileSync(infoPath(userData), 'utf8'));
    if (info === null || typeof info !== 'object') return null;
    const { v, endpoint: where, pid } = info as Record<string, unknown>;
    return v === VERSION && typeof where === 'string' ? { v, endpoint: where, ...(typeof pid === 'number' ? { pid } : {}) } : null;
  } catch {
    return null;
  }
}

/** One reply on the channel. */
export interface Reply {
  v: number;
  ok: boolean;
  handled?: boolean;
  files?: number;
  ms?: number;
  error?: string;
  /** Set by send(): false when no running app answered at all. */
  answered?: boolean;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const codeOf = (error: unknown): string | undefined => {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : undefined;
};

// ---- the server (in the running app) ---------------------------------------------
// Synchronous file calls only: the first asynchronous file call in an Electron main process
// starts libuv's worker threads, which on Windows commit memory that is never released. A
// listening pipe or socket uses the event loop's own completion port or kqueue/epoll.

export interface Channel {
  endpoint: string;
  close(): void;
}

export interface ServeOptions {
  /** The app's data folder: the channel is keyed by it, and control.json is written there. */
  userData: string;
  system: System;
  /** This process's id, written to control.json. */
  pid: number;
  /** The app's own name for the pipe or socket (see endpoint). */
  name?: string;
  /** Carries out one request; requests run one at a time, in order. */
  run: (argv: string[], cwd: string) => Promise<{ handled?: boolean; files?: number } | null | undefined>;
  /** Called as each request arrives, before it runs (for counting). */
  onRequest?: (argv: string[]) => void;
}

/** Listen on the channel. Returns null when it could not be opened. */
export function serve({ userData, system, pid, name, run, onRequest }: ServeOptions): Channel | null {
  const where = endpoint(userData, system, name);
  try {
    // The socket lives in the data folder on macOS and Linux, so the folder must exist first.
    fs.mkdirSync(userData, { recursive: true });
  } catch {
    // listen() below reports the failure by returning a channel nobody can find.
  }
  if (system !== 'windows') {
    // The app holds its single-instance lock for this data folder, so a socket file left here
    // belongs to an app that ended without cleaning up.
    try {
      fs.unlinkSync(where);
    } catch {
      // Nothing there.
    }
  }
  let chain: Promise<void> = Promise.resolve();
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on('close', () => open.delete(socket));
    let buffer = '';
    socket.setEncoding('utf8');
    const reply = (value: Omit<Reply, 'v'>) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify({ v: VERSION, ...value })}\n`);
    };
    socket.on('error', () => {});
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST) {
        reply({ ok: false, error: 'request too large' });
        return;
      }
      const end = buffer.indexOf('\n');
      if (end === -1) return;
      socket.removeAllListeners('data');
      let request: unknown = null;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {
        reply({ ok: false, error: 'not JSON' });
        return;
      }
      const fields = request !== null && typeof request === 'object' ? (request as Record<string, unknown>) : {};
      const argv = fields['argv'];
      if (fields['v'] !== VERSION || !Array.isArray(argv) || argv.length > 64 || !argv.every((a): a is string => typeof a === 'string')) {
        reply({ ok: false, error: `expected {"v":${VERSION},"argv":[strings]}` });
        return;
      }
      const cwd = typeof fields['cwd'] === 'string' ? fields['cwd'] : process.cwd();
      onRequest?.(argv);
      const started = Date.now();
      chain = chain
        .then(() => run(argv, cwd))
        .then(
          (result) => reply({ ok: true, handled: Boolean(result?.handled), files: result?.files ?? 0, ms: Date.now() - started }),
          (error: unknown) => reply({ ok: false, error: messageOf(error) }),
        );
    });
  });
  server.on('error', () => {});
  try {
    server.listen(where, () => {
      if (system !== 'windows') {
        try {
          fs.chmodSync(where, 0o600);
        } catch {
          // The socket inherits the data folder's protection.
        }
      }
      try {
        fs.mkdirSync(userData, { recursive: true });
        fs.writeFileSync(`${infoPath(userData)}.tmp`, JSON.stringify({ v: VERSION, endpoint: where, pid }));
        fs.renameSync(`${infoPath(userData)}.tmp`, infoPath(userData));
      } catch {
        // Without the file no script can find the channel; the app itself is unaffected.
      }
    });
  } catch {
    return null;
  }
  return {
    endpoint: where,
    close() {
      try {
        const info = readInfo(userData);
        if (info && info.pid === pid) fs.unlinkSync(infoPath(userData));
      } catch {
        // Already gone.
      }
      for (const socket of open) socket.destroy();
      server.close();
      server.unref();
      if (system !== 'windows') {
        try {
          fs.unlinkSync(where);
        } catch {
          // Already gone.
        }
      }
    },
  };
}

// ---- the client ----------------------------------------------------------------

function once(where: string, argv: string[], cwd: string, timeoutMs: number): Promise<Reply & { retry: boolean }> {
  return new Promise((resolve) => {
    let settled = false;
    let text = '';
    const socket = net.connect(where);
    const finish = (value: Reply & { retry: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ v: VERSION, ok: false, error: `no reply in ${timeoutMs} ms`, retry: false }), timeoutMs);
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${JSON.stringify({ v: VERSION, argv, cwd })}\n`));
    socket.on('data', (chunk: string) => {
      text += chunk;
      const end = text.indexOf('\n');
      if (end === -1) return;
      try {
        finish({ ...(JSON.parse(text.slice(0, end)) as Reply), retry: false });
      } catch {
        finish({ v: VERSION, ok: false, error: 'the reply was not JSON', retry: false });
      }
    });
    // Refused or not there: the app is not (yet) listening.
    socket.on('error', (error) => finish({ v: VERSION, ok: false, error: `${codeOf(error) ?? error.message}`, retry: true }));
    socket.on('close', () => finish({ v: VERSION, ok: false, error: 'closed without a reply', retry: false }));
  });
}

export interface SendOptions {
  /** The working folder the app resolves relative paths against. Default process.cwd(). */
  cwd?: string;
  /** How long to keep trying while no app answers; 0 tries once. Default 20000. */
  waitMs?: number;
  /** How long one request may take once connected. Default 60000. */
  timeoutMs?: number;
}

/**
 * Send one request to the app running with this data folder. Resolves to the app's reply, or to
 * { ok: false, answered: false, error } when no app answered. Never rejects.
 */
export async function send(userData: string, argv: string[], { cwd = process.cwd(), waitMs = 20_000, timeoutMs = 60_000 }: SendOptions = {}): Promise<Reply> {
  const until = Date.now() + waitMs;
  let last = 'no control.json in the data folder';
  for (;;) {
    const info = readInfo(userData);
    if (info) {
      const { retry, ...reply } = await once(info.endpoint, argv, cwd, timeoutMs);
      if (!retry) return { ...reply, answered: reply.ok || !/^(ENOENT|ECONNREFUSED|EPIPE)/.test(reply.error ?? '') };
      last = `${reply.error} at ${info.endpoint}`;
    }
    if (Date.now() >= until) return { v: VERSION, ok: false, answered: false, error: `no running app answers for ${userData}: ${last}` };
    await new Promise((r) => setTimeout(r, 200));
  }
}
