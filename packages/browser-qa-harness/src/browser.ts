import type { Browser, LaunchOptions } from 'playwright-core';

export interface LaunchAttempt {
  /** Label shown in the failure message and returned as `channel`. */
  name: string;
  options: LaunchOptions;
}

export interface LaunchBrowserOptions {
  /**
   * A browser to try first: a path to any Chromium-family executable, or a Playwright channel name
   * such as `chrome` or `msedge`. `bundled` means the Chromium that Playwright installs.
   */
  browser?: string;
  /** Environment variable holding an executable path, tried after `browser`. Default `QA_BROWSER`. */
  envVar?: string;
  /** Channels tried after those above, in order. `bundled` is Playwright's own Chromium. Default `['msedge', 'chrome', 'bundled']`. */
  channels?: string[];
  /** Run without a window. Default true. */
  headless?: boolean;
  /** Extra Chromium arguments, added to the defaults. */
  args?: string[];
  /** Keep browser audio muted. Default true. */
  mute?: boolean;
  /** Playwright module to use instead of importing `playwright-core` (or `playwright`). */
  playwright?: { chromium: { launch(options?: LaunchOptions): Promise<Browser> } };
  /** Environment to read `envVar` from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Platform name used for the Linux-only arguments. Default `process.platform`. */
  platform?: string;
}

export interface LaunchedBrowser {
  browser: Browser;
  /** Which attempt worked: `executable-path`, a channel name or `bundled`. */
  channel: string;
}

/** Thrown when no browser could be launched. `tried` has one line per attempt. */
export class BrowserLaunchError extends Error {
  readonly tried: string[];
  constructor(tried: string[]) {
    super(
      `No browser could be launched.\n${tried.join('\n')}\nInstall Edge or Chrome, point the QA_BROWSER environment variable at a Chromium executable, or install Playwright's Chromium.`,
    );
    this.name = 'BrowserLaunchError';
    this.tried = tried;
  }
}

/** Chromium arguments for a run: muted audio, autoplay allowed, and the container flags Linux needs. */
export function launchArgs(options: Pick<LaunchBrowserOptions, 'args' | 'mute' | 'platform'> = {}): string[] {
  const args = ['--autoplay-policy=no-user-gesture-required'];
  if (options.mute ?? true) args.unshift('--mute-audio');
  if ((options.platform ?? process.platform) === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  return [...args, ...(options.args ?? [])];
}

const looksLikePath = (value: string) => /[\\/]/.test(value) || /\.(exe|app)$/i.test(value);

function attemptFor(entry: string): LaunchAttempt {
  if (entry === 'bundled') return { name: 'bundled', options: {} };
  if (looksLikePath(entry)) return { name: 'executable-path', options: { executablePath: entry } };
  return { name: entry, options: { channel: entry } };
}

/** The ordered list of launch attempts for the given options. Pure, so it can be checked without a browser. */
export function browserAttempts(options: LaunchBrowserOptions = {}): LaunchAttempt[] {
  const attempts: LaunchAttempt[] = [];
  if (options.browser) attempts.push(attemptFor(options.browser));
  const fromEnv = (options.env ?? process.env)[options.envVar ?? 'QA_BROWSER'];
  if (fromEnv) attempts.push({ name: 'executable-path', options: { executablePath: fromEnv } });
  for (const channel of options.channels ?? ['msedge', 'chrome', 'bundled']) attempts.push(attemptFor(channel));
  return attempts;
}

async function loadPlaywright(): Promise<NonNullable<LaunchBrowserOptions['playwright']>> {
  try {
    return await import('playwright-core');
  } catch {
    const fallback = 'playwright';
    try {
      return (await import(fallback)) as NonNullable<LaunchBrowserOptions['playwright']>;
    } catch {
      throw new Error('Install playwright-core (or playwright) to launch a browser: npm install playwright-core');
    }
  }
}

/**
 * Launches the first browser that works, headless and muted. Playwright is a peer dependency, loaded
 * on first use. Throws `BrowserLaunchError` with every failure when none starts.
 */
export async function launchBrowser(options: LaunchBrowserOptions = {}): Promise<LaunchedBrowser> {
  const playwright = options.playwright ?? (await loadPlaywright());
  const args = launchArgs(options);
  const tried: string[] = [];
  for (const attempt of browserAttempts(options)) {
    try {
      const browser = await playwright.chromium.launch({ ...attempt.options, headless: options.headless ?? true, args });
      return { browser, channel: attempt.name };
    } catch (error) {
      tried.push(`${attempt.name}: ${String(error).split('\n')[0]}`);
    }
  }
  throw new BrowserLaunchError(tried);
}
