import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Absolute path of the canonical `installed-check.sh` shipped in this package. */
export const installedCheckScript: string = fileURLToPath(new URL('../scripts/installed-check.sh', import.meta.url));

export const INSTALLED_CHECK_STEPS = ['list', 'helpers', 'launch', 'collect', 'memory', 'quit', 'uninstall'] as const;
export type InstalledCheckStep = (typeof INSTALLED_CHECK_STEPS)[number];

export interface InstalledCheckMemory {
  mb: number;
  budgetMb: number;
  ceilingMb: number;
}

export interface InstalledCheckReport {
  /** Every line that starts with `FAILED:`, without the prefix. */
  failed: string[];
  /** The script reached its last line. A script that was killed or crashed did not. */
  finished: boolean;
  /** Present for the memory step. */
  memory?: InstalledCheckMemory;
  /** The memory step said the app is over budget and the reason must be recorded. */
  overBudget: boolean;
  /** `finished` and no failures. */
  passed: boolean;
}

/** Reads the text an `installed-check.sh` step wrote (its stdout, or `installed-<step>.txt`). */
export function parseInstalledCheckOutput(text: string): InstalledCheckReport {
  const lines = text.split(/\r?\n/).map((line) => line.trimEnd());
  const failed = lines.filter((line) => line.startsWith('FAILED:')).map((line) => line.slice('FAILED:'.length).trim());
  const finished = lines.filter((line) => line !== '').at(-1) === 'done';
  const overBudget = lines.some((line) => line.startsWith('over budget:'));
  const report: InstalledCheckReport = { failed, finished, overBudget, passed: finished && failed.length === 0 };
  for (const line of lines) {
    const match = /^memory: ([\d.]+) MB \(.*\); budget ([\d.]+) MB, ceiling ([\d.]+) MB$/.exec(line);
    if (match) report.memory = { mb: Number(match[1]), budgetMb: Number(match[2]), ceilingMb: Number(match[3]) };
  }
  return report;
}

export interface InstalledCheckOptions {
  /** The names file the packaging step wrote (`PACKAGE_ENV`). */
  packageEnv: string;
  /** Where `installed-<step>.txt` and the other result files go (`EVIDENCE`). */
  evidenceDir: string;
  /** The folder with the app's own control.cjs, installed-helpers.cjs and installed-diagnostics.cjs (`APP_SCRIPTS`). */
  appScripts?: string;
  dataDir?: string;
  installTo?: string;
  kind?: 'deb' | 'portable';
  noActivate?: boolean;
  emptyPath?: boolean;
  launchExtra?: string;
  budgetMb?: number;
  ceilingMb?: number;
  /** Extra environment variables. The current environment is passed through. */
  env?: NodeJS.ProcessEnv;
  /** Default 120000. */
  timeoutMs?: number;
  /** Shell to run the script with. Default `sh`. */
  shell?: string;
}

export interface InstalledCheckRun {
  step: InstalledCheckStep;
  exitCode: number;
  output: string;
  report: InstalledCheckReport;
}

/** The environment variables the script reads, built from the options. */
export function installedCheckEnvironment(options: InstalledCheckOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, PACKAGE_ENV: options.packageEnv, EVIDENCE: options.evidenceDir };
  const optional: Array<[string, string | number | undefined]> = [
    ['APP_SCRIPTS', options.appScripts],
    ['DATA_DIR', options.dataDir],
    ['INSTALL_TO', options.installTo],
    ['KIND', options.kind],
    ['LAUNCH_EXTRA', options.launchExtra],
    ['BUDGET_MB', options.budgetMb],
    ['CEILING_MB', options.ceilingMb],
  ];
  for (const [name, value] of optional) if (value !== undefined) env[name] = String(value);
  if (options.noActivate) env.NO_ACTIVATE = '1';
  if (options.emptyPath) env.EMPTY_PATH = '1';
  return env;
}

/** Runs one step of the installed-app check on macOS or Linux and returns its output and verdict. */
export function runInstalledCheck(step: InstalledCheckStep, options: InstalledCheckOptions): Promise<InstalledCheckRun> {
  if (!INSTALLED_CHECK_STEPS.includes(step)) return Promise.reject(new RangeError(`Unknown step '${String(step)}'`));
  return new Promise((resolve, reject) => {
    execFile(
      options.shell ?? 'sh',
      [installedCheckScript, step],
      { env: installedCheckEnvironment(options), timeout: options.timeoutMs ?? 120_000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const output = String(stdout) + String(stderr);
        const code = error && typeof (error as { code?: unknown }).code === 'number' ? ((error as { code: number }).code) : error ? -1 : 0;
        if (error && code === -1) return reject(error);
        resolve({ step, exitCode: code, output, report: parseInstalledCheckOutput(output) });
      },
    );
  });
}
