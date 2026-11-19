import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auditCss,
  auditPage,
  copiedText,
  drainMotion,
  installMotionRecorder,
  launchBrowser,
  openPage,
  runMotionSteps,
  serveFolder,
  settle,
} from '../src/index.js';
import type { LaunchedBrowser, ServedFolder } from '../src/index.js';

let launched: LaunchedBrowser | null = null;
try {
  launched = await launchBrowser();
} catch {
  launched = null;
}

const INDEX = `<!doctype html><html><head><style>
:root { --slow: 800ms; }
.fade { transition: opacity 100ms; }
.bad { transition: all 1s; }
.var { transition: transform var(--slow); }
.grow { width: 10px; height: 10px; background: red; }
.wide { width: 3000px; height: 10px; background: blue; }
@keyframes spin { to { transform: rotate(1turn); } }
.spin { animation: spin 1s linear infinite; width: 10px; height: 10px; }
</style></head><body>
<button id="copy">copy</button>
<div class="fade" id="fade">x</div>
<div class="grow" id="grow"></div>
<div class="wide"></div>
<img src="/missing.png" alt="">
<script>
  window.addEventListener('load', () => { setTimeout(() => console.error('boom'), 0); });
  document.getElementById('copy').addEventListener('click', () => navigator.clipboard.writeText('hello'));
</script>
</body></html>`;

describe.skipIf(launched === null)('with a browser', () => {
  let dir: string;
  let site: ServedFolder;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'qa-harness-'));
    await writeFile(path.join(dir, 'index.html'), INDEX);
    site = await serveFolder(dir, { requireIndex: true });
  });

  afterAll(async () => {
    await site?.close();
    await launched?.browser.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('collects page errors and failed requests', async () => {
    const { context, page, errors, failedRequests } = await openPage(launched!.browser, { width: 800, height: 600 });
    await page.goto(site.url);
    await page.waitForTimeout(100);
    expect(errors.some((e) => e.includes('boom'))).toBe(true);
    expect(failedRequests.some((r) => r.startsWith('404') && r.includes('missing.png'))).toBe(true);
    await context.close();
  });

  it('audits overflow and broken images', async () => {
    const { context, page } = await openPage(launched!.browser, { width: 800, height: 600 });
    await page.goto(site.url);
    const audit = await auditPage(page);
    expect(audit.overflow).toBeGreaterThan(1000);
    expect(audit.overflowingElements.some((e) => e.startsWith('div.wide'))).toBe(true);
    expect(audit.brokenImages).toEqual(['/missing.png']);
    await context.close();
  });

  it('captures clipboard writes and freezes time', async () => {
    const { context, page } = await openPage(launched!.browser, { captureClipboard: true, fixedTime: new Date('2030-01-02T03:04:05Z'), storage: { theme: 'light' } });
    await page.goto(site.url);
    await page.click('#copy');
    expect(await copiedText(page)).toEqual(['hello']);
    expect(await page.evaluate(() => new Date().getUTCFullYear())).toBe(2030);
    expect(await page.evaluate(() => localStorage.getItem('theme'))).toBe('light');
    await context.close();
  });

  it('reads stylesheet rules, resolving variables, and reports violations', async () => {
    const { context, page } = await openPage(launched!.browser);
    await page.goto(site.url);
    const result = await auditCss(page);
    expect(result.declarationsRead).toBeGreaterThanOrEqual(3);
    expect(result.violations.some((v) => v.includes('.bad') && v.includes('"all"'))).toBe(true);
    expect(result.violations.some((v) => v.includes('.var') && v.includes('800 ms'))).toBe(true);
    expect(result.violations.some((v) => v.includes('.fade'))).toBe(false);
    await context.close();
  });

  it('records motion that runs and judges it', async () => {
    const { context, page } = await openPage(launched!.browser);
    await installMotionRecorder(page);
    await page.goto(site.url);
    const report = await runMotionSteps(page, [
      {
        label: 'slow layout transition',
        run: async (p) => {
          await p.evaluate(() => {
            const el = document.getElementById('grow') as HTMLElement;
            el.style.transition = 'width 600ms';
            void el.offsetWidth;
            el.style.width = '50px';
          });
          await p.waitForTimeout(100);
        },
      },
      {
        label: 'quick fade',
        run: async (p) => {
          await p.evaluate(() => {
            const el = document.getElementById('fade') as HTMLElement;
            el.style.opacity = '0.2';
          });
          await p.waitForTimeout(150);
        },
      },
    ]);
    expect(report.violations.some((v) => v.includes('slow layout transition') && v.includes('runs 600 ms'))).toBe(true);
    expect(report.violations.some((v) => v.includes('slow layout transition') && v.includes('layout property'))).toBe(true);
    expect(report.violations.some((v) => v.includes('quick fade'))).toBe(false);
    expect(await drainMotion(page)).toEqual([]);
    await context.close();
  });

  it('settles when only endless animations remain', async () => {
    const { context, page } = await openPage(launched!.browser);
    await page.goto(site.url);
    await page.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'spin';
      document.body.append(el);
    });
    await settle(page, { timeout: 2000 });
    await context.close();
  });
});

describe('serveFolder', () => {
  it('refuses a folder without an index when asked to', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-harness-empty-'));
    try {
      await expect(serveFolder(dir, { requireIndex: true })).rejects.toThrow(/index\.html/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('serves files without caching', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'qa-harness-serve-'));
    await writeFile(path.join(dir, 'a.txt'), 'hi');
    const site = await serveFolder(dir);
    try {
      const res = await fetch(`${site.url}/a.txt`);
      expect(await res.text()).toBe('hi');
      expect(res.headers.get('cache-control')).toBe('no-store');
    } finally {
      await site.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
