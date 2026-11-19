import { generateServiceWorker, ShellServiceWorkerError, type ShellServiceWorkerOptions } from './generate.js';

export interface CliIo {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  stdout(text: string): void;
  stderr(text: string): void;
}

export const HELP = `Usage: app-shell-service-worker [options]

Generates a service worker script. Options from --config are overridden by flags.

  --config <file>               JSON file with the options (same names as the function)
  --out <file>                  Write the script here instead of stdout
  --cache-name <name>
  --version <value>
  --precache <url>[,<url>...]   Repeatable
  --navigation-fallback <url>
  --navigation-strategy <network-first|cache-first>
  --asset-strategy <cache-first|network-first>
  --bypass-prefix <path>        Repeatable
  --allow-navigation <path>     Repeatable; only these paths are handled
  --runtime-destination <kind>  Repeatable (script, style, image, font, ...)
  --cleanup <prefix|all>
  --cleanup-prefix <prefix>
  --skip-waiting <immediate|message>
  --no-ignore-search
  --no-runtime-cache
  --no-bypass-authorized
  -h, --help
`;

const VALUE_FLAGS: Record<string, keyof ShellServiceWorkerOptions | 'config' | 'out'> = {
  '--config': 'config',
  '--out': 'out',
  '--cache-name': 'cacheName',
  '--version': 'version',
  '--precache': 'precache',
  '--navigation-fallback': 'navigationFallback',
  '--navigation-strategy': 'navigationStrategy',
  '--asset-strategy': 'assetStrategy',
  '--bypass-prefix': 'bypassPrefixes',
  '--allow-navigation': 'navigationAllowlist',
  '--runtime-destination': 'runtimeDestinations',
  '--cleanup': 'cleanup',
  '--cleanup-prefix': 'cleanupPrefix',
  '--skip-waiting': 'skipWaiting',
};

const LIST_FLAGS = new Set(['precache', 'bypassPrefixes', 'navigationAllowlist', 'runtimeDestinations']);

const NEGATIVE_FLAGS: Record<string, keyof ShellServiceWorkerOptions> = {
  '--no-ignore-search': 'ignoreSearch',
  '--no-runtime-cache': 'runtimeCache',
  '--no-bypass-authorized': 'bypassAuthorized',
};

/** Runs the command line. Returns the process exit code: 0 on success, 1 on bad input, 2 on usage errors. */
export function runCli(argv: string[], io: CliIo): number {
  const flags: Record<string, unknown> = {};
  let config: string | undefined;
  let out: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      io.stdout(HELP);
      return 0;
    }
    if (arg in NEGATIVE_FLAGS) {
      flags[NEGATIVE_FLAGS[arg]] = false;
      continue;
    }
    const key = VALUE_FLAGS[arg];
    if (!key) {
      io.stderr(`Unknown option: ${arg}\n\n${HELP}`);
      return 2;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      io.stderr(`Missing value for ${arg}\n`);
      return 2;
    }
    i += 1;
    if (key === 'config') config = value;
    else if (key === 'out') out = value;
    else if (LIST_FLAGS.has(key)) {
      const items = value.split(',').filter((item) => item !== '');
      flags[key] = [...((flags[key] as string[] | undefined) ?? []), ...items];
    } else flags[key] = value;
  }

  try {
    let options: Record<string, unknown> = {};
    if (config !== undefined) {
      const parsed: unknown = JSON.parse(io.readFile(config));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ShellServiceWorkerError('config file must contain a JSON object');
      }
      options = parsed as Record<string, unknown>;
    }
    const script = generateServiceWorker({ ...options, ...flags } as unknown as ShellServiceWorkerOptions);
    if (out !== undefined) io.writeFile(out, script);
    else io.stdout(script);
    return 0;
  } catch (error) {
    io.stderr(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
