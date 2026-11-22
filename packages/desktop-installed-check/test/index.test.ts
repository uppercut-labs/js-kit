import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INSTALLED_CHECK_STEPS,
  installedCheckEnvironment,
  installedCheckScript,
  parseInstalledCheckOutput,
  runInstalledCheck,
  type InstalledCheckOptions,
} from '../src/index.js';

const exec = promisify(execFile);
const posix = process.platform !== 'win32';

describe('parseInstalledCheckOutput', () => {
  it('passes a finished run with no failures', () => {
    const report = parseInstalledCheckOutput('step list at now on Linux x64\ninstalled at: /opt/x (10 kB)\ndone\n');
    expect(report).toEqual({ failed: [], finished: true, overBudget: false, passed: true });
  });

  it('collects every FAILED line without its prefix', () => {
    const report = parseInstalledCheckOutput('step list\nFAILED: nothing installed at /opt/x\nFAILED: codesign --verify --deep --strict\ndone\n');
    expect(report.failed).toEqual(['nothing installed at /opt/x', 'codesign --verify --deep --strict']);
    expect(report.passed).toBe(false);
    expect(report.finished).toBe(true);
  });

  it('does not pass a run that never reached its last line', () => {
    const report = parseInstalledCheckOutput('step launch\nprocesses running from /opt/x: 3\n');
    expect(report.finished).toBe(false);
    expect(report.passed).toBe(false);
  });

  it('reads the memory line and the over-budget note', () => {
    const text = [
      'step memory',
      'memory: 412 MB (Anonymous + Swap from smaps_rollup, summed over 5 processes); budget 300 MB, ceiling 680 MB',
      'over budget: record the reason or bring it down',
      'done',
    ].join('\n');
    const report = parseInstalledCheckOutput(text);
    expect(report.memory).toEqual({ mb: 412, budgetMb: 300, ceilingMb: 680 });
    expect(report.overBudget).toBe(true);
    expect(report.passed).toBe(true);
  });

  it('treats a line that only contains FAILED: later in the text as not a failure', () => {
    expect(parseInstalledCheckOutput('note: FAILED: not at the start\ndone').failed).toEqual([]);
  });

  it('handles CRLF line endings and an empty output', () => {
    expect(parseInstalledCheckOutput('FAILED: x\r\ndone\r\n').failed).toEqual(['x']);
    expect(parseInstalledCheckOutput('')).toEqual({ failed: [], finished: false, overBudget: false, passed: false });
  });
});

describe('installedCheckEnvironment', () => {
  const base: InstalledCheckOptions = { packageEnv: '/p/package.env', evidenceDir: '/p/evidence' };

  it('sets the required names and nothing optional by default', () => {
    const env = installedCheckEnvironment({ ...base, env: { PATH: '/bin' } });
    expect(env.PACKAGE_ENV).toBe('/p/package.env');
    expect(env.EVIDENCE).toBe('/p/evidence');
    expect(env.NO_ACTIVATE).toBeUndefined();
  });

  it('maps every option to the variable the script reads', () => {
    const env = installedCheckEnvironment({
      ...base,
      appScripts: '/app/scripts',
      dataDir: '/data',
      installTo: '/apps',
      kind: 'portable',
      noActivate: true,
      emptyPath: true,
      launchExtra: '--mute-audio',
      budgetMb: 250,
      ceilingMb: 600,
    });
    expect(env).toMatchObject({
      APP_SCRIPTS: '/app/scripts',
      DATA_DIR: '/data',
      INSTALL_TO: '/apps',
      KIND: 'portable',
      NO_ACTIVATE: '1',
      EMPTY_PATH: '1',
      LAUNCH_EXTRA: '--mute-audio',
      BUDGET_MB: '250',
      CEILING_MB: '600',
    });
  });
});

describe('installed-check.sh', () => {
  it('ships with the package and has every step the wrapper lists', () => {
    expect(existsSync(installedCheckScript)).toBe(true);
    const text = readFileSync(installedCheckScript, 'utf8');
    for (const step of INSTALLED_CHECK_STEPS) expect(text, step).toMatch(new RegExp(`^  ${step}\\)`, 'm'));
    expect(text).not.toContain('\r');
  });

  describe.skipIf(!posix)('run through sh', () => {
    let dir: string;
    let options: InstalledCheckOptions;
    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), 'installed-check-'));
      writeFileSync(
        join(dir, 'package.env'),
        'PRODUCT_NAME="Example App"\nEXE_NAME=example\nLINUX_NAME=example\nAPP_ID=test.example\nVERSION=0.0.0\nHELPERS="tool"\n',
      );
      options = { packageEnv: join(dir, 'package.env'), evidenceDir: join(dir, 'evidence'), installTo: join(dir, 'apps'), kind: 'portable' };
    });
    afterAll(() => rmSync(dir, { recursive: true, force: true }));

    it('is valid POSIX shell', async () => {
      await expect(exec('sh', ['-n', installedCheckScript])).resolves.toBeDefined();
    });

    it('fails the list step with a clear reason when nothing is installed', async () => {
      const run = await runInstalledCheck('list', options);
      expect(run.exitCode).toBe(1);
      expect(run.report.failed).toHaveLength(1);
      expect(run.report.failed[0]).toMatch(/^nothing installed at /);
      expect(run.report.finished).toBe(false);
      expect(readFileSync(join(dir, 'evidence', 'installed-list.txt'), 'utf8')).toContain('FAILED: nothing installed');
    });

    it('passes the quit step when the app is not running', async () => {
      const run = await runInstalledCheck('quit', options);
      expect(run.exitCode).toBe(0);
      expect(run.output).toContain('nothing to close');
      expect(run.report.passed).toBe(true);
    });

    it('fails the memory step when the app is not running', async () => {
      const run = await runInstalledCheck('memory', options);
      expect(run.exitCode).toBe(1);
      expect(run.report.failed[0]).toMatch(/^the app is not running/);
    });

    it('fails the collect step without a running app', async () => {
      const run = await runInstalledCheck('collect', options);
      expect(run.exitCode).toBe(1);
      expect(run.report.failed[0]).toMatch(/not running/);
    });

    it('fails an unknown step and exits nonzero', async () => {
      const result = await exec('sh', [installedCheckScript, 'bogus'], { env: installedCheckEnvironment(options) }).catch((error) => error);
      expect(result.code).toBe(1);
      const report = parseInstalledCheckOutput(String(result.stdout));
      expect(report.failed[0]).toMatch(/^unknown step 'bogus'/);
      expect(report.finished).toBe(true);
      expect(report.passed).toBe(false);
    });

    it('stops with a clear message when the names file is missing', async () => {
      const env = installedCheckEnvironment({ ...options, packageEnv: join(dir, 'missing.env') });
      const result = await exec('sh', [installedCheckScript, 'list'], { env }).catch((error) => error);
      expect(result.code).toBe(1);
      expect(String(result.stderr)).toContain('does not exist. Set PACKAGE_ENV.');
    });

    it('starts when the names file has no HELPERS', async () => {
      writeFileSync(join(dir, 'nohelpers.env'), 'PRODUCT_NAME="Example App"\nEXE_NAME=example\nLINUX_NAME=example\nAPP_ID=test.example\nVERSION=0.0.0\n');
      const run = await runInstalledCheck('list', { ...options, packageEnv: join(dir, 'nohelpers.env') });
      expect(run.output).toContain('FAILED: nothing installed');
      expect(run.output).not.toContain('unbound variable');
    });

    it('rejects a step the script does not have before running anything', async () => {
      await expect(runInstalledCheck('bogus' as never, options)).rejects.toThrow(RangeError);
    });

    it.skipIf(process.platform !== 'darwin')('checks each signature of a product whose name has a space as one path (macOS)', async () => {
      // An unsigned stand-in bundle: every signature check fails, but each must name a whole path.
      const app = join(dir, 'apps', 'Example App.app');
      mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
      mkdirSync(join(app, 'Contents', 'Resources', 'bin', `darwin-${process.arch}`), { recursive: true });
      writeFileSync(join(app, 'Contents', 'MacOS', 'example'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(app, 'Contents', 'Resources', 'bin', `darwin-${process.arch}`, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
      writeFileSync(join(app, 'Contents', 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.example</string></dict></plist>');
      try {
        const run = await runInstalledCheck('list', options);
        const lacking = run.report.failed.filter((f) => f.includes('lacks the hardened runtime flag'));
        expect(lacking).toHaveLength(2);
        expect(lacking[0]).toContain('Example App.app');
        expect(lacking[1]).toMatch(/^Contents\/Resources\/bin\/darwin-[a-z0-9]+\/tool lacks/);
      } finally {
        rmSync(join(dir, 'apps'), { recursive: true, force: true });
      }
    });
  });

  // A stand-in installed app: a copy of `sleep` placed where the script looks for the app's executable,
  // so the script finds it by the program file of the process, as it finds the real app.
  describe.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')('with a running stand-in app', () => {
    let dir: string;
    let child: ChildProcess;
    let options: InstalledCheckOptions;
    beforeAll(async () => {
      dir = mkdtempSync(join(tmpdir(), 'installed-check-run-'));
      writeFileSync(join(dir, 'package.env'), 'PRODUCT_NAME="Example App"\nEXE_NAME=example\nLINUX_NAME=example\nAPP_ID=test.example\nVERSION=0.0.0\n');
      const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
      const root =
        process.platform === 'darwin' ? join(dir, 'apps', 'Example App.app') : join(dir, 'apps', `example-0.0.0-linux-${arch}`);
      const exe = process.platform === 'darwin' ? join(root, 'Contents', 'MacOS', 'example') : join(root, 'example');
      mkdirSync(join(exe, '..'), { recursive: true });
      copyFileSync(process.platform === 'darwin' ? '/bin/sleep' : '/usr/bin/sleep', exe);
      options = { packageEnv: join(dir, 'package.env'), evidenceDir: join(dir, 'evidence'), installTo: join(dir, 'apps'), kind: 'portable' };
      child = spawn(exe, ['120'], { stdio: 'ignore' });
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    afterAll(() => {
      child.kill();
      rmSync(dir, { recursive: true, force: true });
    });

    it('finds the app by its program file and measures it within the default budget and ceiling', async () => {
      const run = await runInstalledCheck('memory', options);
      expect(run.report.failed).toEqual([]);
      expect(run.report.finished).toBe(true);
      expect(run.report.memory).toMatchObject({ budgetMb: 300, ceilingMb: 680 });
      expect(run.output).toContain('within budget');
      expect(run.output).toContain('summed over 1 processes');
    });

    it('notes an app over its budget without failing it', async () => {
      const run = await runInstalledCheck('memory', { ...options, budgetMb: 0, ceilingMb: 100000 });
      expect(run.exitCode).toBe(0);
      expect(run.report.overBudget).toBe(true);
      expect(run.report.passed).toBe(true);
    });

    it('fails an app over its ceiling', async () => {
      const run = await runInstalledCheck('memory', { ...options, budgetMb: 0, ceilingMb: 0 });
      expect(run.exitCode).toBe(1);
      expect(run.report.failed).toEqual(['over the ceiling']);
    });

    it('refuses to launch a second copy and to uninstall a running app', async () => {
      const launch = await runInstalledCheck('launch', options);
      expect(launch.report.failed[0]).toMatch(/^the app is already running from /);
      const uninstall = await runInstalledCheck('uninstall', options);
      expect(uninstall.exitCode).toBe(1);
      expect(uninstall.report.failed[0]).toMatch(/^the app is running\. Run the quit step first/);
    });

    it('lists the installed app instead of reporting nothing installed', async () => {
      const run = await runInstalledCheck('list', options);
      expect(run.output).toContain('installed at: ');
      expect(run.output).not.toContain('nothing installed');
    });
  });
});
