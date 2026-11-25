import { PGlite } from '@electric-sql/pglite';
import initSqlJs from 'sql.js';
import type { D1Like } from '../src/d1.js';
import type { PgLike } from '../src/postgres.js';

/** A D1-shaped binding over sql.js, so the real SQLite SQL runs. */
export async function createFakeD1(): Promise<D1Like & { exec(sql: string): void; all(sql: string, values?: unknown[]): Array<Record<string, unknown>>; calls: string[] }> {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  const calls: string[] = [];
  const read = (sql: string, values: unknown[]) => {
    const stmt = sqlite.prepare(sql);
    stmt.bind(values as never[]);
    const rows: Array<Record<string, unknown>> = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  };
  return {
    calls,
    exec: (sql) => void sqlite.exec(sql),
    all: (sql, values = []) => read(sql, values),
    prepare(sql) {
      calls.push(sql);
      return {
        bind: (...values) => ({
          // A statement that has RETURNING must be stepped; plain writes report changes.
          first: async <T>() => (read(sql, values)[0] ?? null) as T | null,
          run: async () => {
            sqlite.run(sql, values as never[]);
            return { meta: { changes: sqlite.getRowsModified() } };
          },
        }),
      };
    },
  };
}

/** A pg-shaped client over PGlite (real Postgres in WebAssembly). */
export async function createFakePg(): Promise<PgLike & { raw: PGlite }> {
  const raw = new PGlite();
  await raw.waitReady;
  return {
    raw,
    async query(text, values) {
      const result = await raw.query<Record<string, unknown>>(text, values as never[]);
      return { rows: result.rows, rowCount: result.affectedRows ?? null };
    },
  };
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/**
 * Reference copy of the limiter this package replaces in a Workers codebase: HMAC fingerprint,
 * atomic D1 reservation with fail-closed behavior. Kept here so the package can be run beside it.
 */
export function referenceD1(db: D1Like, table = 'ref_rate_limits') {
  async function tryAcquire(storeId: string, fingerprint: string, windowStart: number, expiresAt: number, maxAttempts: number) {
    const row = await db.prepare(`INSERT INTO ${table}
      (store_id,fingerprint,window_start,expires_at,attempts) VALUES(?,?,?,?,1)
      ON CONFLICT(store_id,fingerprint,window_start) DO UPDATE SET attempts=attempts+1
      WHERE attempts < ? AND expires_at=excluded.expires_at RETURNING attempts`)
      .bind(storeId, fingerprint, windowStart, expiresAt, maxAttempts).first<{ attempts: number }>();
    return row !== null;
  }
  return async function consume(
    fingerprintKey: Uint8Array,
    policy: { maxAttempts: number; windowMs: number },
    attempt: { storeId: string; action: string; subject: string; now: number },
  ) {
    if (fingerprintKey.byteLength < 32 || !IDENTIFIER.test(attempt.storeId) || !IDENTIFIER.test(attempt.action)
      || attempt.subject.length === 0 || attempt.subject.length > 2048) throw new Error('invalid_input');
    const windowStart = Math.floor(attempt.now / policy.windowMs) * policy.windowMs;
    const expiresAt = windowStart + policy.windowMs;
    const key = await crypto.subtle.importKey('raw', Uint8Array.from(fingerprintKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const payload = new TextEncoder().encode(JSON.stringify([attempt.storeId, attempt.action, attempt.subject]));
    const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, payload));
    const fingerprint = [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const allowed = await tryAcquire(attempt.storeId, fingerprint, windowStart, expiresAt, policy.maxAttempts);
    return { allowed, retryAfterMs: allowed ? 0 : expiresAt - attempt.now, fingerprint };
  };
}

/**
 * Reference copy of an older Postgres limiter: it stores the raw key, counts every attempt including
 * refused ones, and answers `count <= max`.
 */
export function referencePg(db: PgLike, table = 'ref_auth_limits') {
  return async function consume(key: string, windowSeconds: number, max: number, now: number) {
    const windowMs = windowSeconds * 1000;
    const start = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
    const result = await db.query(
      `INSERT INTO ${table} (key, window_start, count) VALUES ($1, $2::timestamptz, 1)
       ON CONFLICT (key, window_start) DO UPDATE SET count = ${table}.count + 1 RETURNING count`,
      [key, start],
    );
    return Number(result.rows[0]!.count) <= max;
  };
}
