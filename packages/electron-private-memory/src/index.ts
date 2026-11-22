// Private memory of a running Electron app, summed over its processes, by the definition that
// fits each system (Chromium's own "private footprint"):
//   Windows  private bytes of the processes Electron started (app.getAppMetrics)
//   macOS    phys_footprint over the process tree, read with /usr/bin/footprint
//   Linux    anonymous resident memory plus swap (Anonymous + Swap in /proc/<pid>/smaps_rollup)
// and compared with a budget and a ceiling.
//
// Plain Node. Electron is never imported: on Windows pass `app.getAppMetrics`. Reading
// processes and running programs go through options, so every path runs under test.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

export type System = 'windows' | 'macos' | 'linux';

const MB = 1024 * 1024;
const round = (bytes: number) => Math.round((bytes / MB) * 10) / 10;

export interface ProcessMemory {
  pid: number;
  name: string | null;
  privateMB: number;
  residentMB?: number;
  /** Linux: why a process in the tree could not be read. */
  unreadable?: string;
}

/** The part of Electron's ProcessMetric this package reads. Memory values are in kilobytes. */
export interface ProcessMetricLike {
  pid: number;
  type: string;
  memory: { privateBytes?: number; workingSetSize: number };
}

export interface MeasureOptions {
  /** Which definition to use. Default: from process.platform. */
  system?: System;
  /** The process whose tree is measured. Default process.pid. */
  root?: number;
  /** Windows: Electron's app.getAppMetrics. Required there. */
  getAppMetrics?: () => ProcessMetricLike[];
  /** Budget and ceiling in MB, for the verdict. Defaults 300 and 680. */
  budgetMB?: number;
  ceilingMB?: number;
  /** Runs a program and resolves to its stdout. Default: child_process.execFile with a 15 s limit. */
  run?: (file: string, args: string[]) => Promise<{ error: Error | null; stdout: string }>;
  /** Reads a file as text, or throws. Default fs.readFileSync. */
  readFile?: (file: string) => string;
  /** Lists /proc. Default fs.readdirSync. */
  listProc?: () => string[];
  /** The clock for `at`. Default new Date(). */
  now?: () => Date;
}

export interface MemoryReport {
  at: string;
  system: System;
  definition: string;
  scope: string;
  root: number;
  processes: number;
  privateMB: number;
  budgetMB: number;
  ceilingMB: number;
  withinBudget: boolean;
  underCeiling: boolean;
  detail: ProcessMemory[];
  error?: string;
}

interface Part {
  definition: string;
  scope: string;
  detail: ProcessMemory[];
  totalBytes?: number | null;
  error?: string | null;
}

const defaultRun = (file: string, args: string[]) =>
  new Promise<{ error: Error | null; stdout: string }>((resolve) => {
    execFile(file, args, { timeout: 15_000, maxBuffer: 8 * MB }, (error, stdout) => resolve({ error, stdout: String(stdout) }));
  });

export const systemOf = (platform: NodeJS.Platform = process.platform): System => (platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : 'linux');

/** The ids of `root` and everything it started, from [pid, parent] pairs. */
export function descendants(root: number, pairs: readonly (readonly [number, number])[]): number[] {
  const ids = [root];
  for (let i = 0; i < ids.length; i++) for (const [pid, parent] of pairs) if (parent === ids[i] && !ids.includes(pid)) ids.push(pid);
  return ids;
}

/** `ps -axo pid=,ppid=` output as [pid, parent] pairs. */
export function parsePs(text: string): [number, number][] {
  return text
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((p): p is [number, number] => p.length === 2 && p.every(Number.isFinite));
}

/** `footprint -f bytes --noCategories` output: one entry per process, and the summary total. */
export function parseFootprint(text: string): { detail: ProcessMemory[]; totalBytes: number | null } {
  const detail = [...text.matchAll(/^(.+) \[(\d+)\]: .*Footprint: (\d+) B/gm)].map((m) => ({ pid: Number(m[2]), name: (m[1] ?? '').trim(), privateMB: round(Number(m[3])) }));
  const summary = text.match(/^Summary Footprint: (\d+) B/m);
  return { detail, totalBytes: summary ? Number(summary[1]) : null };
}

/** The kB value of one key in /proc/<pid>/smaps_rollup, 0 when absent. */
export function smapsValue(rollup: string, key: string): number {
  return Number(rollup.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0);
}

function windows(getAppMetrics: (() => ProcessMetricLike[]) | undefined): Part {
  if (!getAppMetrics) return { definition: 'private bytes', scope: 'the processes Electron started', detail: [], error: 'getAppMetrics is required on Windows' };
  // Programs the app starts itself are not in this list; measure them from outside.
  const detail = getAppMetrics().map((m) => ({ pid: m.pid, name: m.type, privateMB: round((m.memory.privateBytes ?? 0) * 1024), residentMB: round(m.memory.workingSetSize * 1024) }));
  return { definition: 'private bytes', scope: 'the processes Electron started', detail };
}

async function macos(root: number, run: NonNullable<MeasureOptions['run']>): Promise<Part> {
  const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=']);
  const ids = descendants(root, parsePs(ps.stdout));
  const out = await run('/usr/bin/footprint', ['-f', 'bytes', '--noCategories', ...ids.flatMap((id) => ['--pid', String(id)])]);
  const { detail, totalBytes } = parseFootprint(out.stdout);
  return { definition: 'phys_footprint', scope: 'the process tree', detail, totalBytes, error: detail.length ? null : String(out.error ?? 'footprint printed nothing') };
}

function linux(root: number, readFile: NonNullable<MeasureOptions['readFile']>, listProc: NonNullable<MeasureOptions['listProc']>): Part {
  const pairs: [number, number][] = [];
  for (const entry of listProc()) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFile(`/proc/${entry}/stat`);
      pairs.push([Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])]);
    } catch {
      // The process ended while it was being read.
    }
  }
  const detail: ProcessMemory[] = [];
  for (const pid of descendants(root, pairs)) {
    try {
      const rollup = readFile(`/proc/${pid}/smaps_rollup`);
      const name = readFile(`/proc/${pid}/comm`).trim();
      detail.push({ pid, name, privateMB: round((smapsValue(rollup, 'Anonymous') + smapsValue(rollup, 'Swap')) * 1024), residentMB: round(smapsValue(rollup, 'Rss') * 1024) });
    } catch (error) {
      const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
      detail.push({ pid, name: null, privateMB: 0, unreadable: typeof code === 'string' ? code : String(error) });
    }
  }
  return { definition: 'anonymous resident memory plus swap', scope: 'the process tree', detail };
}

/** Private memory of the running app now, with the verdict against the budget and the ceiling. */
export async function measureMemory(options: MeasureOptions = {}): Promise<MemoryReport> {
  const system = options.system ?? systemOf();
  const root = options.root ?? process.pid;
  const run = options.run ?? defaultRun;
  const readFile = options.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  const listProc = options.listProc ?? (() => fs.readdirSync('/proc'));
  const part = system === 'windows' ? windows(options.getAppMetrics) : system === 'macos' ? await macos(root, run) : linux(root, readFile, listProc);
  const total = part.totalBytes != null ? round(part.totalBytes) : Math.round(part.detail.reduce((sum, p) => sum + p.privateMB, 0) * 10) / 10;
  const budgetMB = options.budgetMB ?? 300;
  const ceilingMB = options.ceilingMB ?? 680;
  return {
    at: (options.now?.() ?? new Date()).toISOString(),
    system,
    definition: part.definition,
    scope: part.scope,
    root,
    processes: part.detail.length,
    privateMB: total,
    budgetMB,
    ceilingMB,
    withinBudget: total <= budgetMB,
    underCeiling: total <= ceilingMB,
    detail: part.detail,
    ...(part.error ? { error: part.error } : {}),
  };
}
