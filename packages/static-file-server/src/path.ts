import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/** Why a URL path could not be turned into a file inside the root. */
export type PathProblem = 'bad-request' | 'forbidden' | 'not-found';

export type ResolvedPath = { ok: true; file: string; isDirectory: boolean } | { ok: false; problem: PathProblem };

/**
 * Maps a URL path (no query string) to a file or directory inside `root`.
 *
 * The path is percent-decoded first, so `%2e%2e` is treated like `..`. Backslashes and NUL bytes are
 * rejected (`bad-request`), a path that leaves the root is `forbidden`, and a missing entry is
 * `not-found`. The real path after following symlinks must still be inside the real root, so a link
 * that points outside the folder is `forbidden`. Names that merely contain `..`, such as `a..b.txt`,
 * are allowed.
 */
export async function resolveStaticPath(root: string, urlPath: string): Promise<ResolvedPath> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return { ok: false, problem: 'bad-request' };
  }
  if (decoded.includes('\0') || decoded.includes(String.fromCharCode(92))) return { ok: false, problem: 'bad-request' };

  const base = path.resolve(root);
  const candidate = path.resolve(base, `.${decoded.startsWith('/') ? decoded : `/${decoded}`}`);
  if (!isInside(base, candidate)) return { ok: false, problem: 'forbidden' };

  let info;
  let real: string;
  try {
    info = await stat(candidate);
    real = await realpath(candidate);
  } catch {
    return { ok: false, problem: 'not-found' };
  }
  let realRoot: string;
  try {
    realRoot = await realpath(base);
  } catch {
    return { ok: false, problem: 'not-found' };
  }
  if (!isInside(realRoot, real)) return { ok: false, problem: 'forbidden' };
  return { ok: true, file: candidate, isDirectory: info.isDirectory() };
}

/** True when `target` is `root` itself or lies below it. */
export function isInside(root: string, target: string): boolean {
  if (target === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return target.startsWith(prefix);
}
