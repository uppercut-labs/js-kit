import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { defaultSleep, modifierForPlatform, resolveInjector } from './input.js';

/** Focuses the window only when asked, or when the default injector needs it (see CommonOptions.focusWindow). */
function focusWindowIfNeeded(win: WindowLike, options: CommonOptions) {
  if (options.focusWindow ?? !options.injector) win.webContents.focus?.();
}
import {
  armPaletteScript,
  createLatencyProbeScript,
  focusFieldScript,
  paintScript,
  readFieldScript,
  readPaletteScript,
  readProbeScript,
  resetProbeScript,
  type ProbeOptions,
} from './probe.js';
import { computeStats } from './stats.js';
import type { Bounds, CommonOptions, Stats, WindowLike } from './types.js';

// ---- typing ---------------------------------------------------------------------

export interface TypingOptions extends CommonOptions, ProbeOptions {
  /** CSS selector of the text field, for example `#search`. */
  field: string;
  /** Characters to type, one key press each. */
  text: string;
  /** Wait between key presses. Default 35. */
  gapMs?: number;
  /** Wait after the last key before reading results. Default 400. */
  settleMs?: number;
}

export interface TypingResult {
  latency: Stats;
  typed: number;
  fieldLengthAfter: number;
  /** Interactions the browser itself timed at or over the slow threshold. */
  interactionsOverThreshold: number;
  worstEventTimingMs: number;
  /** Whether the field was the active element after the focus step. */
  focused: boolean;
}

interface ProbeReading {
  lat: number[];
  slow: number[];
  length: number;
}

/** Types `text` into the field and measures key-event-to-frame latency for each key. */
export async function measureTyping(win: WindowLike, options: TypingOptions): Promise<TypingResult> {
  const { field, text, gapMs = 35, settleMs = 400 } = options;
  const sleep = options.sleep ?? defaultSleep;
  const injector = resolveInjector(win.webContents, options);
  focusWindowIfNeeded(win, options);
  const focused = (await win.webContents.executeJavaScript(focusFieldScript(field))) === true;
  const installed = await win.webContents.executeJavaScript(createLatencyProbeScript(field, options));
  if (installed !== true) throw new Error(`No element matches ${field}`);
  await win.webContents.executeJavaScript(resetProbeScript);
  for (const ch of text) {
    await injector.press(ch);
    await sleep(gapMs);
  }
  await sleep(settleMs);
  const reading = (await win.webContents.executeJavaScript(readProbeScript(field))) as ProbeReading;
  return {
    latency: computeStats(reading.lat),
    typed: [...text].length,
    fieldLengthAfter: reading.length,
    interactionsOverThreshold: reading.slow.length,
    worstEventTimingMs: reading.slow.length ? Math.max(...reading.slow) : 0,
    focused,
  };
}

// ---- command palette ------------------------------------------------------------

export interface PaletteOptions extends CommonOptions {
  /** CSS selector that matches only while the palette is open. */
  openSelector: string;
  /** Key of the shortcut. Default `k`. */
  key?: string;
  /** Default: `meta` on macOS, `control` elsewhere. */
  modifier?: 'control' | 'meta';
  /** Number of open-close rounds. Default 6. */
  runs?: number;
  /** Key that closes the palette. Default `Escape`. */
  closeKey?: string;
  /** Wait for the palette to appear after the shortcut. Default 300. */
  settleMs?: number;
  /** Wait after the close key. Default 250. */
  closeMs?: number;
}

export interface PaletteResult {
  open: Stats;
  samples: number[];
  runs: number;
  /** Rounds in which the palette never appeared. */
  missed: number;
}

/** Presses the palette shortcut repeatedly and measures key-event-to-frame time until the palette is shown. */
export async function measureCommandPalette(win: WindowLike, options: PaletteOptions): Promise<PaletteResult> {
  const { openSelector, key = 'k', runs = 6, closeKey = 'Escape', settleMs = 300, closeMs = 250 } = options;
  const modifier = options.modifier ?? modifierForPlatform();
  const sleep = options.sleep ?? defaultSleep;
  const injector = resolveInjector(win.webContents, options);
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    await win.webContents.executeJavaScript(armPaletteScript(openSelector, key, modifier));
    await injector.press(key.toUpperCase(), [modifier]);
    await sleep(settleMs);
    const value = await win.webContents.executeJavaScript(readPaletteScript);
    if (typeof value === 'number') samples.push(value);
    await injector.press(closeKey);
    await sleep(closeMs);
  }
  return { open: computeStats(samples), samples, runs, missed: runs - samples.length };
}

// ---- launch marks ---------------------------------------------------------------

export interface DisplayInfo {
  hz?: number;
  scale?: number;
  primary?: boolean;
}

export interface LaunchMarksOptions {
  /** Epoch ms when the process started, taken by the caller as early as it can. */
  launchedAt: number;
  /** Source of the current epoch ms. Default `Date.now`. */
  now?: () => number;
  /** Describes the display the window is on, for example from Electron's `screen`. */
  getDisplay?: (bounds: Bounds | undefined) => DisplayInfo | undefined;
  /** A script to run in the page after the first frame; its result is stored as `bench`. */
  benchScript?: string;
}

export interface LaunchMarks {
  launchedAt: number;
  /** Epoch ms when this function was called; call it from the `did-finish-load` handler. */
  didFinishLoad: number;
  msLaunchToLoad: number;
  paint?: { fcp: number | null; timeOrigin: number; now: number };
  /** Epoch ms of the second animation frame after load. */
  firstFrameAfterLoad?: number;
  msLaunchToFirstFrame?: number;
  display?: DisplayInfo;
  bench?: unknown;
  paintError?: string;
  benchError?: string;
}

/** Records launch-to-load and launch-to-first-frame times, and optionally runs a workload script in the page. */
export async function measureLaunchMarks(win: WindowLike, options: LaunchMarksOptions): Promise<LaunchMarks> {
  const now = options.now ?? Date.now;
  const didFinishLoad = now();
  const marks: LaunchMarks = { launchedAt: options.launchedAt, didFinishLoad, msLaunchToLoad: didFinishLoad - options.launchedAt };
  const display = options.getDisplay?.(win.getBounds?.());
  if (display) marks.display = display;
  try {
    const paint = (await win.webContents.executeJavaScript(paintScript)) as NonNullable<LaunchMarks['paint']>;
    marks.paint = paint;
    marks.firstFrameAfterLoad = paint.timeOrigin + paint.now;
    marks.msLaunchToFirstFrame = Math.round((marks.firstFrameAfterLoad - marks.launchedAt) * 10) / 10;
  } catch (error) {
    marks.paintError = String(error);
  }
  if (options.benchScript) {
    try {
      marks.bench = await win.webContents.executeJavaScript(options.benchScript);
    } catch (error) {
      marks.benchError = String(error);
    }
  }
  return marks;
}

// ---- kill and relaunch ----------------------------------------------------------

export interface KillRecordOptions extends CommonOptions {
  field: string;
  text: string;
  /** Process id to report, so an outside script can terminate it. Default `process.pid`. */
  pid?: number;
  gapMs?: number;
  now?: () => number;
}

export interface KillRecord {
  pid: number;
  /** The whole field value that should be there after recovery. */
  expected: string;
  typed: string;
  lastKeyAt: number;
}

/** The text currently in the field, or null when no element matches. */
export async function readField(win: WindowLike, field: string): Promise<string | null> {
  const value = await win.webContents.executeJavaScript(readFieldScript(field));
  return typeof value === 'string' ? value : null;
}

/**
 * Types into the field and returns what a later run must find. The caller writes the record,
 * terminates the process from outside, relaunches, and compares with {@link checkRecovery}.
 */
export async function typeAndRecord(win: WindowLike, options: KillRecordOptions): Promise<KillRecord> {
  const { field, text, gapMs = 25 } = options;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const injector = resolveInjector(win.webContents, options);
  focusWindowIfNeeded(win, options);
  await win.webContents.executeJavaScript(focusFieldScript(field));
  const before = await readField(win, field);
  if (before === null) throw new Error(`No element matches ${field}`);
  for (const ch of text) {
    await injector.press(ch);
    await sleep(gapMs);
  }
  return { pid: options.pid ?? process.pid, expected: before + text, typed: text, lastKeyAt: now() };
}

export interface RecoveryResult {
  exact: boolean;
  /** The restored text ends with everything typed after the record's starting text. */
  typedSurvived: boolean;
  expectedLength: number;
  restoredLength: number;
  commonPrefixLength: number;
  /** Characters of the expected text missing from the restored text, counted from the first difference. */
  lostChars: number;
}

/** Compares the text restored after a relaunch with the record written before the kill. */
export function checkRecovery(record: Pick<KillRecord, 'expected' | 'typed'>, restored: string): RecoveryResult {
  let common = 0;
  const max = Math.min(record.expected.length, restored.length);
  while (common < max && record.expected[common] === restored[common]) common++;
  return {
    exact: restored === record.expected,
    typedSurvived: restored.endsWith(record.typed),
    expectedLength: record.expected.length,
    restoredLength: restored.length,
    commonPrefixLength: common,
    lostChars: record.expected.length - common,
  };
}

/** Reloads the page and resolves when it has loaded again. */
export function reloadPage(win: WindowLike): Promise<void> {
  const { webContents } = win;
  if (!webContents.reload || !webContents.once) return Promise.reject(new Error('webContents.reload and once are required'));
  return new Promise<void>((done) => {
    webContents.once!('did-finish-load', () => done());
    webContents.reload!();
  });
}

// ---- reports --------------------------------------------------------------------

export interface WindowDescription {
  bounds?: Bounds;
  visible?: boolean;
  focused?: boolean;
}

/** Bounds, visibility and focus of the window, for the report. */
export function describeWindow(win: WindowLike): WindowDescription {
  return { bounds: win.getBounds?.(), visible: win.isVisible?.(), focused: win.isFocused?.() };
}

/** Writes `value` as indented JSON, creating the folder when needed. Returns the absolute path. */
export async function writeJsonReport(file: string, value: unknown): Promise<string> {
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(value, null, 2));
  return target;
}

/** The value of `--name=value` in `argv`, or null. Default `argv` is `process.argv`. */
export function readArg(name: string, argv: readonly string[] = process.argv): string | null {
  const prefix = `--${name}=`;
  const hit = argv.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}
