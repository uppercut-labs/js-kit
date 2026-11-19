#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { runCli } from './cli-core.js';

process.exitCode = runCli(process.argv.slice(2), {
  readFile: (path) => readFileSync(path, 'utf8'),
  writeFile: (path, content) => writeFileSync(path, content),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
});
