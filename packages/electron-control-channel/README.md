# @uppercut-labs/electron-control-channel

Lets scripts talk to a running Electron app without starting a second instance of it. The app serves a named pipe (Windows) or a Unix socket (macOS, Linux) when a script started it, and writes where it listens to `control.json` in its data folder. A script sends one line of JSON and reads one line back.

Why not a second instance: a second launch reaches the running app through Chromium's process singleton, and on Windows that second process calls `AllowSetForegroundWindow` for the running app before any app code runs. When the second launch came from a process allowed to set the foreground, the app's window can jump in front of whatever the person is doing. A request through this channel grants nothing.

It is plain Node and never imports Electron, so the client also runs in test scripts and in the app's own executable acting as Node (`ELECTRON_RUN_AS_NODE=1`).

```sh
npm install @uppercut-labs/electron-control-channel
```

Main process:

```ts
import { app } from 'electron';
import { classify, readInfo, send, serve, serves } from '@uppercut-labs/electron-control-channel';

const system = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const kind = classify(process.argv);

if (kind === 'command') {
  // `MyApp --data-dir=d --diagnostics=x.json`: hand it to the running app and end, without the single-instance lock.
  const reply = await send(app.getPath('userData'), process.argv.slice(1));
  app.exit(reply.ok ? 0 : reply.answered ? 1 : 2);
} else {
  app.requestSingleInstanceLock();
  await app.whenReady();
  if (serves(process.argv)) {
    const channel = serve({ userData: app.getPath('userData'), system, pid: process.pid, name: 'MyApp', run: async (argv, cwd) => handle(argv, cwd) });
    app.on('will-quit', () => channel?.close());
  }
}
```

Script:

```ts
import { send } from '@uppercut-labs/electron-control-channel';

const reply = await send('/tmp/test-data', ['--diagnostics=/tmp/d.json'], { waitMs: 10_000 });
if (!reply.answered) throw new Error(reply.error);
```

## Launch kinds

`classify(argv, { commandFlags })` returns:

| Kind | When | What the app does |
| --- | --- | --- |
| `command` | an argument is a command flag | sends it through the channel and ends; never becomes an instance |
| `agent` | `--no-activate`, `--control` or any `--qa-*` flag, and no command flag | hands it to a running app that answers on the channel, otherwise becomes the app |
| `person` | anything else | the normal path, including a second launch that brings the window forward |

`DEFAULT_COMMAND_FLAGS` is `diagnostics=`, `capture=`, `show-about`, `quit`, `close-window`, `menu-command=`, `full-screen=`, `qa-press=`, `qa-menu-state=`. A flag ending in `=` takes a value. Pass `commandFlags` to `classify` and `isCommandFlag` to add an app's own, for example `[...DEFAULT_COMMAND_FLAGS, 'play=', 'rescan']`.

## Functions

| Function | Returns |
| --- | --- |
| `classify(argv, options?)` | `'command'`, `'agent'` or `'person'`; `argv[0]` is skipped |
| `isCommandFlag(arg, options?)` | whether one argument is a command flag |
| `serves(argv)` | whether a first launch serves the channel: `--no-activate` or `--control` |
| `endpoint(userData, system, name?)` | the pipe or socket path: `\\.\pipe\<name>-control-<hash>` on Windows (the data folder compared case-insensitively), `<userData>/control.sock` elsewhere, or `/tmp/<name>-control-<hash>.sock` when that path would pass the Unix socket limit |
| `serve(options)` | `{ endpoint, close() }`, or `null` when the channel could not be opened. Options: `userData`, `system`, `pid`, `name`, `run(argv, cwd)`, `onRequest(argv)` |
| `send(userData, argv, options?)` | the reply; never rejects. Options: `cwd`, `waitMs` (20000; 0 tries once), `timeoutMs` (60000) |
| `readInfo(userData)` | what `control.json` says, or `null` |
| `infoPath(userData)` | the path of `control.json` |
| `slug(name)` | the name made safe for a pipe or socket |

`run` resolves to `{ handled, files }`. Requests run one at a time, in arrival order. `close()` removes `control.json` only when it names this process, and removes the socket file.

A reply is `{ v, ok, handled?, files?, ms?, error?, answered? }`. `answered` is `false` only when no app was listening (no `control.json`, or the pipe or socket refused the connection), so a script can tell "no app" from "the app said no".

## Protocol

One request per connection, one line of JSON each way, version 1:

```
request  {"v":1,"argv":["--diagnostics=C:\\x.json","--capture=C:\\x.png"],"cwd":"C:\\"}
reply    {"v":1,"ok":true,"handled":true,"files":0,"ms":412}
         {"v":1,"ok":false,"error":"..."}
```

A request over 64 KB, one that is not JSON, or one without a string array `argv` of at most 64 entries gets an error reply rather than no answer. On macOS and Linux the socket is made readable by its owner only.

The server uses synchronous file calls on purpose: in an Electron main process the first asynchronous file call starts libuv's worker threads, which on Windows commit memory that is never released.

## License

MIT
