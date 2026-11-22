import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, DEFAULT_COMMAND_FLAGS, endpoint, isCommandFlag, readInfo, send, serve, serves, slug } from '../src/index.js';
import type { System } from '../src/index.js';

const SYSTEM: System = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const exe = 'C:\\app\\Example.exe';

describe('classify', () => {
  it('makes every default command flag a command launch, with or without --no-activate', () => {
    for (const flag of ['--diagnostics=x.json', '--capture=x.png', '--show-about', '--quit', '--close-window', '--menu-command=about', '--full-screen=on', '--qa-press=F11', '--qa-menu-state={}']) {
      expect(classify([exe, '--data-dir=d', '--no-activate', flag]), flag).toBe('command');
      expect(classify([exe, flag]), flag).toBe('command');
    }
  });

  it('makes a script launch without a command an agent launch, and anything else a person launch', () => {
    expect(classify([exe, '--no-activate'])).toBe('agent');
    expect(classify([exe, '--no-activate', 'C:\\docs\\a.txt'])).toBe('agent');
    expect(classify([exe, '--qa-typing=out.json'])).toBe('agent');
    expect(classify([exe, '--control'])).toBe('agent');
    expect(classify([exe])).toBe('person');
    expect(classify([exe, 'C:\\docs\\a.txt'])).toBe('person');
    expect(classify([exe, '--data-dir=d'])).toBe('person');
  });

  it('takes an app\'s own command flags (launchers add play= and rescan)', () => {
    const commandFlags = [...DEFAULT_COMMAND_FLAGS, 'play=', 'rescan'];
    expect(classify([exe, '--play=mp4'], { commandFlags })).toBe('command');
    expect(classify([exe, '--rescan'], { commandFlags })).toBe('command');
    expect(classify([exe, '--rescan'])).toBe('person');
    expect(isCommandFlag('--rescanned', { commandFlags })).toBe(false);
    expect(isCommandFlag('quit')).toBe(false);
  });
});

describe('serves and endpoint', () => {
  it('serves only for a script launch', () => {
    expect(serves([exe, '--no-activate'])).toBe(true);
    expect(serves([exe, '--control'])).toBe(true);
    expect(serves([exe, 'C:\\docs\\a.txt'])).toBe(false);
  });

  it('names the pipe after the app and the data folder, case-insensitively on Windows', () => {
    expect(endpoint('C:\\Users\\x\\AppData\\Roaming\\My App', 'windows', 'MyApp')).toMatch(/^\\\\\.\\pipe\\myapp-control-[0-9a-f]{16}$/);
    expect(endpoint('C:\\X', 'windows', 'a')).toBe(endpoint('c:\\x', 'windows', 'a'));
    expect(endpoint('C:\\x', 'windows', 'Two Words')).toMatch(/\\two-words-control-[0-9a-f]{16}$/);
    expect(endpoint('C:\\x', 'windows')).toMatch(/\\app-control-[0-9a-f]{16}$/);
    expect(slug('')).toBe('app');
  });

  it('keeps a Unix socket path under the system limit', () => {
    expect(endpoint('/Users/x/data', 'macos', 'Example')).toBe('/Users/x/data/control.sock');
    const long = `/Volumes/External/${'x'.repeat(120)}`;
    expect(endpoint(long, 'linux', 'Example')).toMatch(/^\/tmp\/example-control-[0-9a-f]{16}\.sock$/);
  });
});

describe('a request through a real pipe or socket', () => {
  it('replies in order, answers garbage, and reports when no app runs', async () => {
    const userData = fs.mkdtempSync(path.join(SYSTEM === 'macos' ? '/tmp' : os.tmpdir(), 'control-'));
    try {
      const none = await send(userData, ['--quit'], { waitMs: 0 });
      expect(none.ok).toBe(false);
      expect(none.answered).toBe(false);

      const got: { argv: string[]; cwd: string }[] = [];
      let arrived = 0;
      const channel = serve({
        userData,
        system: SYSTEM,
        pid: process.pid,
        name: 'Example',
        onRequest: () => (arrived += 1),
        run: async (argv, cwd) => {
          got.push({ argv, cwd });
          await new Promise((r) => setTimeout(r, 30));
          return { handled: argv.some((a) => a.startsWith('--')), files: 0 };
        },
      });
      expect(channel).not.toBeNull();
      const [a, b] = await Promise.all([send(userData, ['--diagnostics=a.json'], { cwd: '/x', waitMs: 3000 }), send(userData, ['--capture=b.png'], { waitMs: 3000 })]);
      expect(a.ok).toBe(true);
      expect(a.handled).toBe(true);
      expect(a.answered).toBe(true);
      expect(b.ok).toBe(true);
      expect(got).toHaveLength(2);
      expect(arrived).toBe(2);
      expect(got.find((g) => g.argv[0] === '--diagnostics=a.json')?.cwd).toBe('/x');
      expect(readInfo(userData)?.pid).toBe(process.pid);

      const where = readInfo(userData)?.endpoint;
      expect(where).toBeTruthy();
      const garbage = await new Promise<string>((resolve) => {
        const s = net.connect(where as string);
        let text = '';
        s.on('data', (c: Buffer) => (text += String(c)));
        s.on('close', () => resolve(text));
        s.write('not json\n');
      });
      expect((JSON.parse(garbage) as { ok: boolean }).ok).toBe(false);

      const failing = serve({ userData: `${userData}-b`, system: SYSTEM, pid: process.pid, name: 'Other', run: async () => Promise.reject(new Error('it broke')) });
      const broken = await send(`${userData}-b`, ['--quit'], { waitMs: 3000 });
      expect(broken).toMatchObject({ ok: false, error: 'it broke', answered: true });
      failing?.close();

      channel?.close();
      expect(readInfo(userData)).toBeNull();
      expect((await send(userData, ['--quit'], { waitMs: 0 })).answered).toBe(false);
    } finally {
      fs.rmSync(userData, { recursive: true, force: true });
      fs.rmSync(`${userData}-b`, { recursive: true, force: true });
    }
  });
});
