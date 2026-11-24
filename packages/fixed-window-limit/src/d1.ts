import { checkReservation, columnName, tableName } from './sql.js';
import { FixedWindowError } from './types.js';
import type { AcquireResult, CounterStore, Reservation } from './types.js';

/** The part of a Cloudflare D1 binding this store uses. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
}

export interface D1StoreOptions {
  /** Defaults to `fixed_window_counters`. */
  readonly table?: string;
  /** Column names. All five exist in the table; map yours here to keep an existing schema. */
  readonly columns?: {
    readonly partition?: string;
    readonly key?: string;
    readonly windowStart?: string;
    readonly expiresAt?: string;
    readonly count?: string;
  };
}

function names(options: D1StoreOptions) {
  const c = options.columns ?? {};
  return {
    table: tableName(options.table ?? 'fixed_window_counters'),
    partition: columnName(c.partition ?? 'partition'),
    key: columnName(c.key ?? 'key'),
    windowStart: columnName(c.windowStart ?? 'window_start'),
    expiresAt: columnName(c.expiresAt ?? 'expires_at'),
    count: columnName(c.count ?? 'count'),
  };
}

/** SQL that creates the counter table in D1 (SQLite). Run it in a migration. */
export function d1CounterSchema(options: D1StoreOptions = {}): string {
  const n = names(options);
  return `CREATE TABLE IF NOT EXISTS ${n.table} (
  ${n.partition} TEXT NOT NULL,
  ${n.key} TEXT NOT NULL,
  ${n.windowStart} INTEGER NOT NULL,
  ${n.expiresAt} INTEGER NOT NULL,
  ${n.count} INTEGER NOT NULL,
  PRIMARY KEY (${n.partition}, ${n.key}, ${n.windowStart})
);
CREATE INDEX IF NOT EXISTS ${columnName(`${(options.table ?? 'fixed_window_counters').replace(/\W/g, '_')}_expires`)} ON ${n.table} (${n.expiresAt});`;
}

/**
 * Counters in D1. One INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING statement does the whole
 * reservation, and D1 serializes it, so racing callers cannot each take the last slot.
 * The primary key (or a unique index) must cover partition, key and window start.
 */
export function createD1Store(db: D1Like, options: D1StoreOptions = {}): CounterStore {
  const n = names(options);
  const acquire = `INSERT INTO ${n.table} (${n.partition},${n.key},${n.windowStart},${n.expiresAt},${n.count}) VALUES(?,?,?,?,1)
      ON CONFLICT(${n.partition},${n.key},${n.windowStart}) DO UPDATE SET ${n.count}=${n.count}+1
      WHERE ${n.count} < ? AND ${n.expiresAt}=excluded.${n.expiresAt} RETURNING ${n.count} AS attempts`;
  return {
    async tryAcquire(r: Reservation): Promise<AcquireResult> {
      checkReservation(r, true);
      const row = await db.prepare(acquire)
        .bind(r.partition, r.key, r.windowStart, r.expiresAt, r.maxAttempts).first<{ attempts: number }>();
      return row === null ? { allowed: false, count: r.maxAttempts } : { allowed: true, count: Number(row.attempts) };
    },
    async count(w) {
      checkReservation(w, false);
      const row = await db.prepare(`SELECT ${n.count} AS attempts FROM ${n.table} WHERE ${n.partition}=? AND ${n.key}=? AND ${n.windowStart}=?`)
        .bind(w.partition, w.key, w.windowStart).first<{ attempts: number }>();
      return row === null ? 0 : Number(row.attempts);
    },
    async deleteExpired(now, limit) {
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new FixedWindowError('invalid_attempt', 'Invalid rate limit cleanup');
      }
      const result = await db.prepare(`DELETE FROM ${n.table} WHERE rowid IN (
      SELECT rowid FROM ${n.table} WHERE ${n.expiresAt}<=? ORDER BY ${n.expiresAt} LIMIT ?)`).bind(now, limit).run();
      const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
      return typeof changes === 'number' ? changes : 0;
    },
  };
}
