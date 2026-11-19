#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { startStaticServer } from './server.js';

const HELP = `Usage: static-file-server [folder] [options]

Serves a folder over HTTP. The folder defaults to the current directory.

Options:
  -p, --port <n>       Port to listen on (default 8080, 0 picks a free port)
      --host <name>    Interface to bind (default 127.0.0.1)
      --spa            Answer extensionless unknown paths with index.html
      --clean-urls     Try <path>.html and <path>/index.html
      --no-ranges      Ignore Range requests
      --cache <value>  Cache-Control header (default no-cache)
      --dotfiles       Serve paths with dot segments (hidden by default)
  -h, --help           Show this help
`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        port: { type: 'string', short: 'p' },
        host: { type: 'string' },
        spa: { type: 'boolean' },
        'clean-urls': { type: 'boolean' },
        'no-ranges': { type: 'boolean' },
        cache: { type: 'string' },
        dotfiles: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (positionals.length > 1) {
    process.stderr.write(`Expected at most one folder.\n\n${HELP}`);
    return 2;
  }
  const port = values.port === undefined ? 8080 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    process.stderr.write(`Invalid port: ${values.port}\n`);
    return 2;
  }
  const folder = positionals[0] ?? '.';
  const running = await startStaticServer({
    root: folder,
    port,
    host: values.host,
    spaFallback: values.spa,
    cleanUrls: values['clean-urls'],
    ranges: !values['no-ranges'],
    cacheControl: values.cache,
    blockDotfiles: !values.dotfiles,
  });
  process.stdout.write(`Serving ${folder} at ${running.url}\n`);
  const stop = () => {
    void running.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  return -1;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
