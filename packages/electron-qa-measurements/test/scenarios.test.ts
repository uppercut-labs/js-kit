import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  checkRecovery,
  createLatencyProbeScript,
  describeWindow,
  measureCommandPalette,
  measureLaunchMarks,
  measureTyping,
  readField,
  reloadPage,
  typeAndRecord,
  writeJsonReport,
  type KeyInjector,
  type WindowLike,
} from '../src/index.js';
import { FakePage, quickSleep } from './fake-window.js';

describe('window focus', () => {
  const spy = (page: FakePage) => {
    const win = page.window();
    let calls = 0;
    const original = win.webContents.focus?.bind(win.webContents);
    win.webContents.focus = () => {
      calls += 1;
      original?.();
    };
    return { win, calls: () => calls };
  };
  const passThrough = (page: FakePage) => ({ press: async (key: string) => page.window().webContents.sendInputEvent({ type: 'char', keyCode: key }) });

  it('focuses the window for the default injector, which needs it', async () => {
    const page = new FakePage();
    const { win, calls } = spy(page);
    await measureTyping(win, { field: '#field', text: 'ab', gapMs: 1, settleMs: 5, sleep: quickSleep });
    expect(calls()).toBe(1);
  });

  it('never focuses the window when an injector is given (a protocol injector reaches the page without it)', async () => {
    const page = new FakePage();
    const { win, calls } = spy(page);
    await measureTyping(win, { field: '#field', text: 'ab', gapMs: 1, settleMs: 5, sleep: quickSleep, injector: passThrough(page) });
    await typeAndRecord(win, { field: '#field', text: 'cd', gapMs: 1, sleep: quickSleep, injector: passThrough(page) });
    expect(calls()).toBe(0);
  });

  it('follows focusWindow when it is set', async () => {
    const page = new FakePage();
    const { win, calls } = spy(page);
    await measureTyping(win, { field: '#field', text: 'a', gapMs: 1, settleMs: 5, sleep: quickSleep, focusWindow: false });
    await measureTyping(win, { field: '#field', text: 'b', gapMs: 1, settleMs: 5, sleep: quickSleep, injector: passThrough(page), focusWindow: true });
    expect(calls()).toBe(1);
  });
});

describe('measureTyping', () => {
  it('measures one latency sample per typed character through the real probe script', async () => {
    const page = new FakePage();
    const result = await measureTyping(page.window(), { field: '#field', text: 'hello world', gapMs: 4, settleMs: 20, sleep: quickSleep });
    expect(result.typed).toBe(11);
    expect(result.fieldLengthAfter).toBe(11);
    expect(result.latency.samples).toBe(11);
    expect(result.latency.p50).toBeGreaterThanOrEqual(0);
    expect(result.latency.max).toBeGreaterThanOrEqual(result.latency.p95!);
    expect(result.focused).toBe(true);
    expect(page.field.value).toBe('hello world');
  });

  it('reports slow interactions the browser timed', async () => {
    const page = new FakePage();
    let first = true;
    const sleep = async (ms: number) => {
      if (first) {
        first = false;
        page.emitSlow(40);
        page.emitSlow(25);
      }
      await quickSleep(ms);
    };
    const result = await measureTyping(page.window(), { field: '#field', text: 'ab', gapMs: 2, settleMs: 20, sleep });
    expect(result.interactionsOverThreshold).toBe(2);
    expect(result.worstEventTimingMs).toBe(40);
  });

  it('uses a custom injector when one is given', async () => {
    const page = new FakePage();
    const pressed: string[] = [];
    const injector: KeyInjector = { press: (key) => void pressed.push(key) };
    const result = await measureTyping(page.window(), { field: '#field', text: 'xyz', sleep: quickSleep, settleMs: 1, injector });
    expect(pressed).toEqual(['x', 'y', 'z']);
    expect(result.latency.samples).toBe(0);
    expect(page.inputEvents).toEqual([]);
  });

  it('rejects when the field is missing', async () => {
    const page = new FakePage();
    await expect(measureTyping(page.window(), { field: '#nope', text: 'a', sleep: quickSleep })).rejects.toThrow('No element matches #nope');
  });

  it('can run twice on the same page without counting keys twice', async () => {
    const page = new FakePage();
    const win = page.window();
    await measureTyping(win, { field: '#field', text: 'ab', gapMs: 2, settleMs: 10, sleep: quickSleep });
    const second = await measureTyping(win, { field: '#field', text: 'cd', gapMs: 2, settleMs: 10, sleep: quickSleep });
    expect(second.latency.samples).toBe(2);
  });

  it('escapes the selector in the page script', () => {
    const script = createLatencyProbeScript('input[name="a\'b"]');
    expect(script).toContain(JSON.stringify('input[name="a\'b"]'));
  });
});

describe('measureCommandPalette', () => {
  it('times each open and counts rounds where nothing opened', async () => {
    const page = new FakePage();
    const result = await measureCommandPalette(page.window(), { openSelector: '.palette', modifier: 'control', runs: 4, settleMs: 20, closeMs: 5, sleep: quickSleep });
    expect(result.runs).toBe(4);
    expect(result.samples).toHaveLength(4);
    expect(result.missed).toBe(0);
    expect(result.open.samples).toBe(4);
    expect(page.paletteOpen).toBe(false);
  });

  it('uses the meta modifier when asked', async () => {
    const page = new FakePage();
    await measureCommandPalette(page.window(), { openSelector: '.palette', modifier: 'meta', runs: 1, settleMs: 20, closeMs: 5, sleep: quickSleep });
    expect(page.inputEvents[0]).toEqual({ type: 'keyDown', keyCode: 'K', modifiers: ['meta'] });
  });

  it('records a miss when the palette selector never matches', async () => {
    const page = new FakePage();
    const result = await measureCommandPalette(page.window(), { openSelector: '.never', modifier: 'control', runs: 2, settleMs: 5, closeMs: 1, sleep: quickSleep });
    expect(result.missed).toBe(2);
    expect(result.open).toEqual({ samples: 0 });
  });
});

describe('measureLaunchMarks', () => {
  it('computes launch to load and launch to first frame', async () => {
    const page = new FakePage();
    const timeOrigin = Date.now();
    const win: WindowLike = {
      webContents: { ...page.window().webContents, executeJavaScript: async () => ({ fcp: 40, timeOrigin, now: 250 }) },
      getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    };
    const marks = await measureLaunchMarks(win, {
      launchedAt: timeOrigin - 100,
      now: () => timeOrigin + 50,
      getDisplay: (bounds) => ({ hz: 60, scale: 2, primary: bounds?.width === 800 }),
    });
    expect(marks.msLaunchToLoad).toBe(150);
    expect(marks.firstFrameAfterLoad).toBe(timeOrigin + 250);
    expect(marks.msLaunchToFirstFrame).toBe(350);
    expect(marks.display).toEqual({ hz: 60, scale: 2, primary: true });
    expect(marks.bench).toBeUndefined();
  });

  it('runs a bench script and keeps its result', async () => {
    const page = new FakePage();
    const base = page.window();
    const win: WindowLike = {
      webContents: {
        ...base.webContents,
        executeJavaScript: async (source) => (source === '1 + 1' ? { ops: 2 } : { fcp: null, timeOrigin: 0, now: 5 }),
      },
    };
    const marks = await measureLaunchMarks(win, { launchedAt: 0, benchScript: '1 + 1' });
    expect(marks.bench).toEqual({ ops: 2 });
  });

  it('records paint and bench errors instead of throwing', async () => {
    const win: WindowLike = {
      webContents: { executeJavaScript: async () => Promise.reject(new Error('page gone')), sendInputEvent() {} },
    };
    const marks = await measureLaunchMarks(win, { launchedAt: 1, now: () => 5, benchScript: 'x' });
    expect(marks.paintError).toContain('page gone');
    expect(marks.benchError).toContain('page gone');
    expect(marks.msLaunchToLoad).toBe(4);
    expect(marks.paint).toBeUndefined();
  });
});

describe('kill and relaunch', () => {
  it('records the expected text, the pid and the time of the last key', async () => {
    const page = new FakePage();
    page.field.value = 'start: ';
    const record = await typeAndRecord(page.window(), { field: '#field', text: 'abc', pid: 4242, now: () => 99, gapMs: 1, sleep: quickSleep });
    expect(record).toEqual({ pid: 4242, expected: 'start: abc', typed: 'abc', lastKeyAt: 99 });
    expect(page.field.value).toBe('start: abc');
  });

  it('defaults the pid to the current process', async () => {
    const page = new FakePage();
    const record = await typeAndRecord(page.window(), { field: '#field', text: 'a', sleep: quickSleep });
    expect(record.pid).toBe(process.pid);
  });

  it('rejects when the field is missing', async () => {
    const page = new FakePage();
    await expect(typeAndRecord(page.window(), { field: '#nope', text: 'a', sleep: quickSleep })).rejects.toThrow('No element matches #nope');
  });

  it('reads the field value, or null when there is no such element', async () => {
    const page = new FakePage();
    page.field.value = 'kept';
    expect(await readField(page.window(), '#field')).toBe('kept');
    expect(await readField(page.window(), '#nope')).toBeNull();
  });

  it('reports an exact recovery', () => {
    const record = { expected: 'hello world', typed: 'world' };
    expect(checkRecovery(record, 'hello world')).toEqual({
      exact: true,
      typedSurvived: true,
      expectedLength: 11,
      restoredLength: 11,
      commonPrefixLength: 11,
      lostChars: 0,
    });
  });

  it('reports lost trailing characters', () => {
    const result = checkRecovery({ expected: 'hello world', typed: 'world' }, 'hello wo');
    expect(result).toMatchObject({ exact: false, typedSurvived: false, commonPrefixLength: 8, lostChars: 3, restoredLength: 8 });
  });

  it('reports a restored text that differs in the middle', () => {
    const result = checkRecovery({ expected: 'abcdef', typed: 'ef' }, 'abXdef');
    expect(result).toMatchObject({ exact: false, commonPrefixLength: 2, lostChars: 4 });
  });

  it('reports total loss', () => {
    expect(checkRecovery({ expected: 'abc', typed: 'c' }, '')).toMatchObject({ exact: false, commonPrefixLength: 0, lostChars: 3 });
  });
});

describe('reloadPage', () => {
  it('resolves after did-finish-load', async () => {
    let handler: (() => void) | undefined;
    const win: WindowLike = {
      webContents: {
        executeJavaScript: async () => null,
        sendInputEvent() {},
        once: (event, fn) => {
          expect(event).toBe('did-finish-load');
          handler = fn;
        },
        reload: () => setTimeout(() => handler?.(), 1),
      },
    };
    await expect(reloadPage(win)).resolves.toBeUndefined();
  });

  it('rejects when the window cannot reload', async () => {
    const win: WindowLike = { webContents: { executeJavaScript: async () => null, sendInputEvent() {} } };
    await expect(reloadPage(win)).rejects.toThrow('required');
  });
});

describe('reports', () => {
  it('describes a window with whatever it can answer', () => {
    const win: WindowLike = { webContents: { executeJavaScript: async () => null, sendInputEvent() {} }, isVisible: () => true, isFocused: () => false };
    expect(describeWindow(win)).toEqual({ bounds: undefined, visible: true, focused: false });
  });

  it('writes JSON, creating folders', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qa-report-'));
    try {
      const file = await writeJsonReport(join(dir, 'nested', 'report.json'), { ok: true });
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ ok: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
