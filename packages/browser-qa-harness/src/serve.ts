import { existsSync } from 'node:fs';
import path from 'node:path';
import { startStaticServer } from '@uppercut-labs/static-file-server';
import type { StaticOptions } from '@uppercut-labs/static-file-server';

export interface ServeFolderOptions extends Omit<StaticOptions, 'root'> {
  /** Port to listen on. Default 0 (a free port). */
  port?: number;
  /** Interface to bind. Default `127.0.0.1`. */
  host?: string;
  /** Throw when the folder has no `index.html`, which usually means the build has not run. Default false. */
  requireIndex?: boolean;
}

export interface ServedFolder {
  /** Origin such as `http://127.0.0.1:41234`, with no trailing slash. */
  url: string;
  close(): Promise<void>;
}

/**
 * Serves a folder on loopback for a QA run. Files are sent with `cache-control: no-store` unless you
 * pass `cacheControl`, so reruns never see stale builds. Every static-file-server option is accepted,
 * for example `spaFallback: true`.
 */
export async function serveFolder(dir: string, options: ServeFolderOptions = {}): Promise<ServedFolder> {
  const root = path.resolve(dir);
  if (options.requireIndex && !existsSync(path.join(root, options.index ?? 'index.html'))) {
    throw new Error(`No ${options.index ?? 'index.html'} in ${root}. Build the site before serving it.`);
  }
  const { requireIndex: _ignored, ...rest } = options;
  const running = await startStaticServer({ cacheControl: 'no-store', ...rest, root });
  return { url: running.url, close: running.close };
}
