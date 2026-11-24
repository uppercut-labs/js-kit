# js-kit

Small, focused JavaScript and TypeScript packages from Uppercut Labs, each published on its own under the `@uppercut-labs` scope on npm.

| Package | What it does |
| --- | --- |
| [`@uppercut-labs/android-app-links`](packages/android-app-links) | Serve `assetlinks.json` and a branded sign-in return page for Android App Links from package names and signing fingerprints, as a function from Request to Response |
| [`@uppercut-labs/app-icon-generator`](packages/app-icon-generator) | Build every app icon from one source image: PNG sizes, maskable icons, ICO, ICNS, Android and Linux sets and a web manifest icons array |
| [`@uppercut-labs/app-shell-service-worker`](packages/app-shell-service-worker) | Generate an app-shell service worker script from options: precache list, navigation fallback, cache versioning and update behavior. Function and CLI |
| [`@uppercut-labs/browser-qa-harness`](packages/browser-qa-harness) | Headless browser QA helpers: serve a folder, launch a muted browser, open pages with error collection, and audit CSS and runtime motion |
| [`@uppercut-labs/desktop-installed-check`](packages/desktop-installed-check) | Check an installed desktop app on macOS and Linux through files and its control channel, never through input events: one shell script with seven steps and a Node wrapper that reads the verdict |
| [`@uppercut-labs/electron-bridge-test-double`](packages/electron-bridge-test-double) | A fake preload bridge for Electron renderers: call log, event emitters, menu hook, fixture selection and safe storage, so the renderer runs in a plain browser |
| [`@uppercut-labs/electron-child-process-runner`](packages/electron-child-process-runner) | Start and stop child tools from a main process: streamed stdout, stderr tail, grace period then kill, process-tree kill and a done promise with exit info |
| [`@uppercut-labs/electron-command-menu`](packages/electron-command-menu) | Build Electron app and dock menus from one command list, route commands to the focused window, sync enabled and checked state from the page, and format and match shortcuts on Windows and macOS |
| [`@uppercut-labs/electron-control-channel`](packages/electron-control-channel) | Let scripts talk to a running Electron app over a named pipe or Unix socket instead of a second instance: launch classification, server and client |
| [`@uppercut-labs/electron-qa-measurements`](packages/electron-qa-measurements) | Measure typing latency, command-palette open time, launch marks and kill-and-relaunch recovery of an Electron window, with p50, p95 and max statistics |
| [`@uppercut-labs/electron-private-memory`](packages/electron-private-memory) | Private memory of a running Electron app over its processes, by each system's definition, against a budget and a ceiling |
| [`@uppercut-labs/react-modal-dialog`](packages/react-modal-dialog) | Accessible React modal dialog with focus trap, scroll lock, focus restore and Escape or backdrop close, unstyled by default |
| [`@uppercut-labs/react-pwa-install-and-update`](packages/react-pwa-install-and-update) | React hooks for PWAs: capture the install prompt, track standalone mode, register a service worker, and detect and apply updates |
| [`@uppercut-labs/read-body-with-size-limit`](packages/read-body-with-size-limit) | Read a fetch Request or Response body as bytes, text or JSON without buffering more than a byte limit |
| [`@uppercut-labs/static-file-server`](packages/static-file-server) | Dependency-free Node static file server with a path-traversal guard, MIME map, range requests and optional SPA fallback |

Game development packages, `@uppercut-labs/fgc-data` among them, live in [game-kit](https://github.com/uppercut-labs/game-kit). They keep their npm names, so installing them is unchanged.

## Working in this repo

```sh
npm install
npm run check   # build every package, then run all tests
```

Each package lives in `packages/<name>` with its own `package.json`, `README.md` and tests in `test/`. Packages have no runtime dependencies on each other unless their README says so.

See [RELEASING.md](RELEASING.md) for how a version is published.

## License

MIT
