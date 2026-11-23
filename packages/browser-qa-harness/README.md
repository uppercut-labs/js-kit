# @uppercut-labs/browser-qa-harness

Helpers for headless browser checks of a built site. It serves a folder on loopback, launches the first Chromium-family browser that works (muted, headless), opens pages with page errors and failed requests already collected, and audits CSS and runtime animation against motion rules: no `transition: all`, no animated layout properties, nothing slower than a limit, no unexpected endless animation.

Playwright is a peer dependency, so you choose the version. The package does not download browsers.

```sh
npm install --save-dev @uppercut-labs/browser-qa-harness playwright-core
```

```ts
import { auditCss, auditPage, installMotionRecorder, launchBrowser, openPage, runMotionSteps, serveFolder } from '@uppercut-labs/browser-qa-harness';

const site = await serveFolder('./dist', { requireIndex: true, spaFallback: true });
const { browser } = await launchBrowser();
const { context, page, errors, failedRequests } = await openPage(browser, { width: 1280, height: 800 });

await installMotionRecorder(page);
await page.goto(site.url);

console.log(await auditPage(page)); // { overflow, overflowingElements, brokenImages }
console.log(await auditCss(page)); // { violations, longestMs, declarationsRead, ... }
const motion = await runMotionSteps(
  page,
  [{ label: 'open menu', run: (p) => p.click('#menu') }],
  { endlessOk: ['spin'] },
);
console.log(motion.violations, errors, failedRequests);

await context.close();
await browser.close();
await site.close();
```

## Serving and launching

| Function | Returns |
| --- | --- |
| `serveFolder(dir, options)` | `{ url, close() }`. Accepts every `@uppercut-labs/static-file-server` option, plus `port`, `host` and `requireIndex` (throw if there is no `index.html`). Responses are `no-store` unless you set `cacheControl` |
| `launchBrowser(options)` | `{ browser, channel }`. Throws `BrowserLaunchError` listing every failed attempt |
| `browserAttempts(options)` | the ordered launch attempts, without launching |
| `launchArgs(options)` | the Chromium arguments used |

`launchBrowser` options:

| Option | Default | Meaning |
| --- | --- | --- |
| `browser` | none | Tried first: an executable path, a channel name, or `bundled` |
| `envVar` | `QA_BROWSER` | Environment variable holding an executable path, tried second |
| `channels` | `['msedge', 'chrome', 'bundled']` | Then these, in order; `bundled` is Playwright's own Chromium |
| `headless` | `true` | Run without a window |
| `mute` | `true` | Keep audio muted |
| `args` | none | Extra Chromium arguments. On Linux, `--no-sandbox` and `--disable-dev-shm-usage` are added |
| `playwright` | `playwright-core`, then `playwright` | Module to launch with |

## Pages

| Function | Purpose |
| --- | --- |
| `openPage(browser, options)` | New context and page. Returns `{ context, page, errors, failedRequests }` |
| `settle(page, { ignoreAnimations, timeout, extraMs })` | Wait until no transition or animation is running; endless ones and the ignore list do not count |
| `park(page, { x, y })` | Move the pointer to a corner so nothing shows a hover state |
| `auditPage(page, { overflowTolerance })` | `{ overflow, overflowingElements, brokenImages }` |
| `copiedText(page)` | Text the page tried to copy (with `captureClipboard`) |

`openPage` options: `width` (1280), `height` (800), `scale` (1), `colorScheme` (`dark`), `reducedMotion` (`no-preference`), `locale` (`en-US`), `timezone` (`UTC`), `fixedTime`, `captureClipboard`, `storage` (`localStorage` entries set before load if missing), `initScripts`, `contextOptions`.

Use `collectPageDiagnostics(page)` before navigating when Playwright Test or another runner owns the page:

```ts
const diagnostics = collectPageDiagnostics(page);
try {
  await page.goto('/');
  // Run the app's assertions, then read diagnostics.errors and diagnostics.failedRequests.
} finally {
  diagnostics.stop();
}
```

The collector leaves browser and context lifecycle to the caller. Its entries can contain page messages and full URLs. Use fixture data when saving or sharing diagnostics.

## Motion and CSS audit

| Function | Purpose |
| --- | --- |
| `auditCss(page, options)` | Reads the page's stylesheets (with `var()` resolved) and returns `{ violations, longestMs, longestSheetMs, declarationsRead }` |
| `installMotionRecorder(pageOrContext, { sheetSelector })` | Records every animation that runs. Call before navigating |
| `drainMotion(page)` | Recorded animations since the last call |
| `runMotionSteps(page, steps, options)` | Runs `{ label, run(page) }` steps and judges what each started: `{ steps, violations }` |
| `judgeMotion(records, label, options)` | Violation messages for recorded animations |
| `classifyCssDeclarations(declarations, options)` | The CSS rules on plain data, no browser needed |

Options shared by these: `limits` (`{ default: 300, sheet: 450 }` milliseconds), `layoutProperties` (property names counted as layout), `endlessOk` (animation names allowed to run forever and not judged by length), and for CSS `sheetPattern` (selectors that get the sheet limit). `sheetSelector` does the same for recorded motion.

## Errors

`launchBrowser` throws `BrowserLaunchError` with a `tried` array. It also throws if neither `playwright-core` nor `playwright` can be imported. `serveFolder` rejects when `requireIndex` is set and the folder has no index, or when the port cannot be bound.

## License

MIT
