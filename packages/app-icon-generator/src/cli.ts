import { parseArgs } from 'node:util';
import { ALL_TARGETS, generate, type IconTarget } from './generate.js';

const USAGE = `Usage: app-icon-generator <source> --out <dir> [options]

Options:
  --out <dir>                 Output folder (required)
  --targets <list>            Comma-separated: ${ALL_TARGETS.join(',')} (default: all)
  --fit <cover|contain>       How the source fills the square (default: cover)
  --background <color>        Fill behind contained images
  --maskable-inset <n>        Margin per side of maskable icons, 0 to 0.45 (default: 0.1)
  --maskable-background <c>   Background of maskable and apple-touch icons (default: #ffffff)
  --mac-art-scale <n>         Share of the canvas the ICNS artwork fills (default: 0.8047)
  --manifest                  Write icons.manifest.json
  --manifest-base <prefix>    URL prefix in the manifest (default: /icons/)
  -h, --help                  Show this help
`;

/** Runs the command line and returns the process exit code. */
export async function runCli(
  argv: string[],
  log: (line: string) => void = console.log,
  logError: (line: string) => void = console.error,
): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        targets: { type: 'string' },
        fit: { type: 'string' },
        background: { type: 'string' },
        'maskable-inset': { type: 'string' },
        'maskable-background': { type: 'string' },
        'mac-art-scale': { type: 'string' },
        manifest: { type: 'boolean' },
        'manifest-base': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    logError((error as Error).message);
    logError(USAGE);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    log(USAGE);
    return 0;
  }
  if (positionals.length !== 1 || !values.out) {
    logError('A source image and --out are required.');
    logError(USAGE);
    return 2;
  }
  if (values.fit !== undefined && values.fit !== 'cover' && values.fit !== 'contain') {
    logError(`--fit must be cover or contain, got "${values.fit}"`);
    return 2;
  }
  const number = (name: string, raw: string | undefined): number | undefined => {
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`--${name} must be a number, got "${raw}"`);
    return value;
  };
  try {
    const result = await generate(positionals[0], {
      outDir: values.out,
      targets: values.targets
        ? (values.targets.split(',').map((t) => t.trim()).filter(Boolean) as IconTarget[])
        : undefined,
      fit: values.fit,
      background: values.background,
      maskableInset: number('maskable-inset', values['maskable-inset']),
      maskableBackground: values['maskable-background'],
      macArtScale: number('mac-art-scale', values['mac-art-scale']),
      manifest: values.manifest,
      manifestBase: values['manifest-base'],
    });
    for (const file of result.files) log(file);
    log(`${result.files.length} files written to ${values.out}`);
    return 0;
  } catch (error) {
    logError((error as Error).message);
    return 1;
  }
}
