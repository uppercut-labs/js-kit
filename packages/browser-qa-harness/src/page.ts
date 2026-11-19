import type { Browser, BrowserContext, BrowserContextOptions, Page } from 'playwright-core';

export interface OpenPageOptions {
  /** Viewport width in CSS pixels. Default 1280. */
  width?: number;
  /** Viewport height in CSS pixels. Default 800. */
  height?: number;
  /** Device scale factor. Default 1. */
  scale?: number;
  /** `prefers-color-scheme`. Default `dark`. */
  colorScheme?: 'light' | 'dark' | 'no-preference';
  /** `prefers-reduced-motion`. Default `no-preference`. */
  reducedMotion?: 'reduce' | 'no-preference';
  /** Default `en-US`. */
  locale?: string;
  /** IANA time zone. Default `UTC`. */
  timezone?: string;
  /** Freeze `Date` at this time so screenshots do not change from run to run. */
  fixedTime?: Date | string | number;
  /** Catch clipboard writes instead of touching the machine's clipboard; read them with `copiedText(page)`. */
  captureClipboard?: boolean;
  /** `localStorage` entries to set before the page loads, if the key is not already set. */
  storage?: Record<string, string>;
  /** Scripts to run in every page before its own scripts. */
  initScripts?: string[];
  /** Extra Playwright context options, applied last. */
  contextOptions?: BrowserContextOptions;
}

export interface OpenedPage {
  context: BrowserContext;
  page: Page;
  /** Uncaught page errors and `console.error` messages, as they arrive. */
  errors: string[];
  /** Requests that failed or answered 400 and above, as `status url` or `FAILED url`. */
  failedRequests: string[];
}

/** The Playwright context options for a set of page options. Pure. */
export function contextOptionsFor(options: OpenPageOptions = {}): BrowserContextOptions {
  return {
    viewport: { width: options.width ?? 1280, height: options.height ?? 800 },
    deviceScaleFactor: options.scale ?? 1,
    colorScheme: options.colorScheme ?? 'dark',
    reducedMotion: options.reducedMotion ?? 'no-preference',
    locale: options.locale ?? 'en-US',
    timezoneId: options.timezone ?? 'UTC',
    ...options.contextOptions,
  };
}

/** Runs in the page: replaces the clipboard writers with ones that record text in `window.__copied`. */
export function installClipboardCapture(): void {
  const w = window as unknown as { __copied: string[] };
  w.__copied = [];
  const capture = async (text: unknown) => {
    w.__copied.push(String(text));
  };
  try {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: capture, readText: async () => w.__copied[w.__copied.length - 1] ?? '' },
    });
  } catch {
    // The page falls back to execCommand, which is caught below.
  }
  document.execCommand = (command: string) => {
    if (command === 'copy') w.__copied.push(String(document.getSelection() ?? ''));
    return command === 'copy';
  };
}

function seedStorage(entries: Record<string, string>): void {
  try {
    for (const [key, value] of Object.entries(entries)) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
  } catch {
    // Storage is unavailable; the page uses its defaults.
  }
}

/** Opens a page in a fresh browser context, with error and failed-request collection already attached. */
export async function openPage(browser: Browser, options: OpenPageOptions = {}): Promise<OpenedPage> {
  const context = await browser.newContext(contextOptionsFor(options));
  if (options.captureClipboard) await context.addInitScript(installClipboardCapture);
  if (options.storage && Object.keys(options.storage).length > 0) await context.addInitScript(seedStorage, options.storage);
  for (const script of options.initScripts ?? []) await context.addInitScript(script);

  const page = await context.newPage();
  if (options.fixedTime !== undefined) await page.clock.setFixedTime(options.fixedTime);
  const errors: string[] = [];
  const failedRequests: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('requestfailed', (request) => failedRequests.push(`FAILED ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400) failedRequests.push(`${response.status()} ${response.url()}`);
  });
  return { context, page, errors, failedRequests };
}

/** Text the page tried to copy since `openPage({ captureClipboard: true })`, oldest first. */
export function copiedText(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied?: string[] }).__copied ?? []);
}

/** Moves the pointer to a corner of the page so nothing shows a hover state. */
export async function park(page: Page, at: { x: number; y: number } = { x: 1, y: 1 }): Promise<void> {
  await page.mouse.move(at.x, at.y);
}

export interface SettleOptions {
  /** Animation or transition names that may keep running, for example `['spin']`. Endless animations are always ignored. */
  ignoreAnimations?: string[];
  /** Longest wait in milliseconds. Default 5000. */
  timeout?: number;
  /** Extra wait after the animations end. Default 60. */
  extraMs?: number;
}

/** Resolves when no CSS transition or animation is running, apart from endless ones and the ignore list. */
export async function settle(page: Page, options: SettleOptions = {}): Promise<void> {
  await page.waitForFunction(
    (ignore: string[]) =>
      document.getAnimations().every((animation) => {
        const name = (animation as CSSAnimation).animationName ?? (animation as CSSTransition).transitionProperty ?? '';
        return animation.effect?.getComputedTiming().iterations === Infinity || animation.playState !== 'running' || ignore.includes(name);
      }),
    options.ignoreAnimations ?? [],
    { timeout: options.timeout ?? 5000 },
  );
  const extra = options.extraMs ?? 60;
  if (extra > 0) await page.waitForTimeout(extra);
}

export interface PageAudit {
  /** Pixels the page is wider than the window, or 0. */
  overflow: number;
  /** Up to 20 elements that stick out past the right edge, as `tag.class`. */
  overflowingElements: string[];
  /** `src` of images that finished loading without any pixels. */
  brokenImages: string[];
}

export interface AuditPageOptions {
  /** Pixels of overflow to ignore (rounding). Default 1. */
  overflowTolerance?: number;
}

/** Checks the loaded page for horizontal overflow and broken images. */
export async function auditPage(page: Page, options: AuditPageOptions = {}): Promise<PageAudit> {
  return page.evaluate((tolerance: number) => {
    const doc = document.documentElement;
    const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth);
    const overflowingElements: string[] = [];
    if (overflow > tolerance) {
      for (const el of Array.from(document.body.querySelectorAll('*'))) {
        if (overflowingElements.length >= 20) break;
        const box = el.getBoundingClientRect();
        if (box.width > 0 && box.right > doc.clientWidth + tolerance) {
          const cls = typeof el.className === 'string' ? el.className.split(/\s+/).filter(Boolean).slice(0, 2).join('.') : '';
          overflowingElements.push(`${el.tagName.toLowerCase()}${cls ? `.${cls}` : ''}`);
        }
      }
    }
    const brokenImages = Array.from(document.images)
      .filter((img) => img.complete && img.naturalWidth === 0)
      .map((img) => img.getAttribute('src') ?? '');
    return { overflow: overflow > tolerance ? overflow : 0, overflowingElements, brokenImages };
  }, options.overflowTolerance ?? 1);
}
