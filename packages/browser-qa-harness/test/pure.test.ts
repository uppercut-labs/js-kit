import { describe, expect, it } from 'vitest';
import {
  BrowserLaunchError,
  browserAttempts,
  classifyCssDeclarations,
  contextOptionsFor,
  cssTimeToMs,
  isLayoutProperty,
  judgeMotion,
  launchArgs,
  launchBrowser,
  splitTopLevel,
  timesIn,
} from '../src/index.js';
import type { CssDeclaration, MotionRecord } from '../src/index.js';

const decl = (selector: string, name: string, value: string, loops = false): CssDeclaration => ({ selector, name, raw: value, value, loops });
const record = (over: Partial<MotionRecord>): MotionRecord => ({
  kind: 'CSSTransition',
  name: 'opacity',
  properties: ['opacity'],
  duration: 150,
  iterations: 1,
  target: 'div.box',
  inSheet: false,
  ...over,
});

describe('css time helpers', () => {
  it('converts seconds and milliseconds', () => {
    expect(cssTimeToMs('300ms')).toBe(300);
    expect(cssTimeToMs('.5s')).toBe(500);
    expect(cssTimeToMs('2s')).toBe(2000);
  });

  it('splits only on top-level commas', () => {
    expect(splitTopLevel('opacity .2s cubic-bezier(0.1, 0.2, 0.3, 0.4), transform 1s')).toEqual([
      'opacity .2s cubic-bezier(0.1, 0.2, 0.3, 0.4)',
      'transform 1s',
    ]);
    expect(splitTopLevel('')).toEqual([]);
  });

  it('finds durations and delays but not function arguments', () => {
    expect(timesIn('opacity 200ms ease 50ms')).toEqual([200, 50]);
    expect(timesIn('transform .3s cubic-bezier(.1,.7,1,.1)')).toEqual([300]);
    expect(timesIn('fade 1s steps(4, jump-end)')).toEqual([1000]);
  });

  it('recognises layout properties and their longhands in either casing', () => {
    expect(isLayoutProperty('height')).toBe(true);
    expect(isLayoutProperty('margin-left')).toBe(true);
    expect(isLayoutProperty('marginLeft')).toBe(true);
    expect(isLayoutProperty('fontSize')).toBe(true);
    expect(isLayoutProperty('opacity')).toBe(false);
    expect(isLayoutProperty('transform')).toBe(false);
    expect(isLayoutProperty('topic')).toBe(false);
  });
});

describe('classifyCssDeclarations', () => {
  it('flags transition: all, layout properties and slow durations', () => {
    const result = classifyCssDeclarations([
      decl('.a', 'transition', 'all 100ms'),
      decl('.b', 'transition', 'height .2s'),
      decl('.c', 'animation-duration', '.5s'),
      decl('.d', 'transition', 'opacity 200ms, transform 250ms'),
    ]);
    expect(result.violations).toHaveLength(3);
    expect(result.violations.some((v) => v.includes('.a') && v.includes('"all"'))).toBe(true);
    expect(result.violations.some((v) => v.includes('.b') && v.includes('layout property height'))).toBe(true);
    expect(result.violations.some((v) => v.includes('.c') && v.includes('500 ms'))).toBe(true);
    expect(result.violations.some((v) => v.includes('.d'))).toBe(false);
    expect(result.longestMs).toBe(500);
  });

  it('reports each slow segment of a multi-value transition', () => {
    const result = classifyCssDeclarations([decl('.e', 'transition', 'opacity 400ms, transform 100ms')]);
    expect(result.violations).toEqual(['.e { transition: opacity 400ms, transform 100ms } runs 400 ms (limit 300)']);
  });

  it('skips endless animations and transition-property for duration', () => {
    const result = classifyCssDeclarations([
      decl('.spin', 'animation', 'spin 5s linear infinite'),
      decl('.loop', 'animation-duration', '9s', true),
      decl('.p', 'transition-property', 'opacity, transform'),
    ]);
    expect(result.violations).toEqual([]);
    expect(result.longestMs).toBe(0);
  });

  it('uses the sheet limit for selectors that match the sheet pattern', () => {
    const rules = [decl('.sheet-panel', 'transition', 'transform 400ms'), decl('.card', 'transition', 'transform 400ms')];
    const result = classifyCssDeclarations(rules, { sheetPattern: /sheet/ });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toContain('.card');
    expect(result.longestSheetMs).toBe(400);
  });

  it('honours custom limits and layout lists', () => {
    const rules = [decl('.a', 'transition', 'opacity 150ms'), decl('.b', 'transition', 'color 50ms')];
    expect(classifyCssDeclarations(rules, { limits: { default: 100 } }).violations).toHaveLength(1);
    expect(classifyCssDeclarations(rules, { layoutProperties: ['color'] }).violations).toHaveLength(1);
  });

  it('accepts an empty list', () => {
    expect(classifyCssDeclarations([])).toEqual({ violations: [], longestMs: 0, longestSheetMs: 0 });
  });
});

describe('judgeMotion', () => {
  it('passes short, non-layout animations', () => {
    expect(judgeMotion([record({})], 'step')).toEqual([]);
  });

  it('flags slow ones with the right limit', () => {
    expect(judgeMotion([record({ duration: 301 })], 'step')).toEqual(['step: opacity on div.box runs 301 ms (limit 300)']);
    expect(judgeMotion([record({ duration: 400, inSheet: true })], 'step')).toEqual([]);
    expect(judgeMotion([record({ duration: 451, inSheet: true })], 'step')).toHaveLength(1);
  });

  it('flags animated layout properties, including camelCase keyframes', () => {
    const out = judgeMotion([record({ name: 'script', properties: ['marginLeft', 'opacity'] })], 's');
    expect(out).toEqual(['s: layout property marginLeft animates on div.box']);
  });

  it('flags endless animations unless allowed', () => {
    const endless = record({ kind: 'CSSAnimation', name: 'pulse', iterations: 'infinite', properties: [] });
    expect(judgeMotion([endless], 's')).toEqual(['s: endless animation pulse on div.box']);
    expect(judgeMotion([endless], 's', { endlessOk: ['pulse'] })).toEqual([]);
  });

  it('does not judge the length of an allowed animation', () => {
    expect(judgeMotion([record({ name: 'scroll-cue', duration: 5000 })], 's', { endlessOk: ['scroll-cue'] })).toEqual([]);
  });

  it('uses the transition name when keyframes list no properties', () => {
    expect(judgeMotion([record({ name: 'height', properties: [] })], 's')).toHaveLength(1);
  });
});

describe('launch helpers', () => {
  it('mutes audio and adds container flags only on Linux', () => {
    expect(launchArgs({ platform: 'darwin' })).toEqual(['--mute-audio', '--autoplay-policy=no-user-gesture-required']);
    expect(launchArgs({ platform: 'linux' })).toContain('--no-sandbox');
    expect(launchArgs({ platform: 'win32', mute: false, args: ['--x'] })).toEqual(['--autoplay-policy=no-user-gesture-required', '--x']);
  });

  it('orders attempts: option, environment, channels', () => {
    const attempts = browserAttempts({ browser: '/opt/browser/chrome', env: { QA_BROWSER: '/usr/bin/other' } });
    expect(attempts.map((a) => a.name)).toEqual(['executable-path', 'executable-path', 'msedge', 'chrome', 'bundled']);
    expect(attempts[0]?.options).toEqual({ executablePath: '/opt/browser/chrome' });
    expect(attempts[1]?.options).toEqual({ executablePath: '/usr/bin/other' });
    expect(attempts[2]?.options).toEqual({ channel: 'msedge' });
    expect(attempts[4]?.options).toEqual({});
  });

  it('treats a bare name as a channel and supports a custom variable and channel list', () => {
    const attempts = browserAttempts({ browser: 'chrome-beta', envVar: 'MY_BROWSER', env: { MY_BROWSER: 'C:\\b\\chrome.exe' }, channels: ['bundled'] });
    expect(attempts.map((a) => a.options)).toEqual([{ channel: 'chrome-beta' }, { executablePath: 'C:\\b\\chrome.exe' }, {}]);
  });

  it('launches the first working attempt', async () => {
    const calls: unknown[] = [];
    const fake = {
      chromium: {
        launch: async (options?: Record<string, unknown>) => {
          calls.push(options);
          if (options?.channel === 'msedge') throw new Error('msedge missing\nstack');
          return { fake: true } as never;
        },
      },
    };
    const result = await launchBrowser({ playwright: fake, env: {}, platform: 'darwin' });
    expect(result.channel).toBe('chrome');
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ channel: 'chrome', headless: true, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
  });

  it('throws every failure when nothing launches', async () => {
    const fake = {
      chromium: {
        launch: async () => {
          throw new Error('nope');
        },
      },
    };
    const error = await launchBrowser({ playwright: fake, env: {}, channels: ['chrome', 'bundled'] }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BrowserLaunchError);
    expect((error as BrowserLaunchError).tried).toEqual(['chrome: Error: nope', 'bundled: Error: nope']);
  });
});

describe('contextOptionsFor', () => {
  it('has neutral defaults', () => {
    expect(contextOptionsFor()).toEqual({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 1,
      colorScheme: 'dark',
      reducedMotion: 'no-preference',
      locale: 'en-US',
      timezoneId: 'UTC',
    });
  });

  it('applies options and lets contextOptions win', () => {
    const options = contextOptionsFor({ width: 390, height: 844, scale: 3, colorScheme: 'light', reducedMotion: 'reduce', timezone: 'Europe/Paris', contextOptions: { locale: 'fr-FR' } });
    expect(options).toMatchObject({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 3,
      colorScheme: 'light',
      reducedMotion: 'reduce',
      timezoneId: 'Europe/Paris',
      locale: 'fr-FR',
    });
  });
});
