import { checkReservation, columnName, tableName } from './sql.js';
import { FixedWindowError } from './types.js';
import type { AcquireResult, CounterStore, Reservation } from './types.js';

/** The part of a `pg` Pool or Client (or any compatible driver) this store uses. */
export interface PgLike {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

export interface PostgresStoreOptions {
  /** Defaults to `fixed_window_counters`; `schema.table` is accepted. */
  readonly table?: string;
  readonly columns?: {
    /** Column for the partition, or `null` when the table has none: the fingerprint already includes it. */
    readonly partition?: string | null;
    readonly key?: string;
    readonly windowStart?: string;
    /** Column for the window end, or `null` when the table has none. */
    readonly expiresAt?: string | null;
    readonly count?: string;
  };
  /** `bigint` stores epoch milliseconds (default); `timestamptz` stores a timestamp. */
  readonly windowType?: 'bigint' | 'timestamptz';
  /** Without an expiry column, `deleteExpired` removes windows that started this long before now. Default two days. */
  readonly retainMs?: number;
}

function resolve(options: PostgresStoreOptions) {
  const c = options.columns ?? {};
  const windowType = options.windowType ?? 'bigint';
  if (windowType !== 'bigint' && windowType !== 'timestamptz') throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: windowType');
  const retainMs = options.retainMs ?? 2 * 24 * 60 * 60 * 1000;
  if (!Number.isSafeInteger(retainMs) || retainMs < 0) throw new FixedWindowError('invalid_config', 'Invalid rate limit configuration: retainMs');
  return {
    windowType,
    retainMs,
    table: tableName(options.table ?? 'fixed_window_counters'),
    partition: c.partition === null ? null : columnName(c.partition ?? 'partition'),
    key: columnName(c.key ?? 'key'),
    windowStart: columnName(c.windowStart ?? 'window_start'),
    expiresAt: c.expiresAt === null ? null : columnName(c.expiresAt ?? 'expires_at'),
    count: columnName(c.count ?? 'count'),
  };
}

/** SQL that creates the counter table. Run it in a migration. */
export function postgresCounterSchema(options: PostgresStoreOptions = {}): string {
  const n = resolve(options);
  const type = n.windowType === 'bigint' ? 'bigint' : 'timestamptz';
  const cols = [
    n.partition && `${n.partition} text NOT NULL`,
    `${n.key} text NOT NULL`,
    `${n.windowStart} ${type} NOT NULL`,
    n.expiresAt && `${n.expiresAt} ${type} NOT NULL`,
    `${n.count} integer NOT NULL`,
    `PRIMARY KEY (${[n.partition, n.key, n.windowStart].filter(Boolean).join(', ')})`,
  ].filter(Boolean);
  return `CREATE TABLE IF NOT EXISTS ${n.table} (\n  ${cols.join(',\n  ')}\n);`;
}

/**
 * Counters in Postgres. One INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING statement does the
 * reservation, so concurrent callers across instances cannot each take the last slot.
 * The primary key (or a unique index) must cover the partition (if any), key and window start.
 */
export function createPostgresStore(db: PgLike, options: PostgresStoreOptions = {}): CounterStore {
  const n = resolve(options);
  const time = (index: number) => (n.windowType === 'bigint' ? `$${index}` : `$${index}::timestamptz`);
  const timeValue = (ms: number) => (n.windowType === 'bigint' ? ms : new Date(ms).toISOString());
  return {
    async tryAcquire(r: Reservation): Promise<AcquireResult> {
      checkReservation(r, true);
      const columns: string[] = [];
      const placeholders: string[] = [];
      const values: unknown[] = [];
      const add = (column: string, placeholder: (index: number) => string, value: unknown) => {
        columns.push(column);
        values.push(value);
        placeholders.push(placeholder(values.length));
      };
      if (n.partition) add(n.partition, (i) => `$${i}`, r.partition);
      add(n.key, (i) => `$${i}`, r.key);
      add(n.windowStart, time, timeValue(r.windowStart));
      if (n.expiresAt) add(n.expiresAt, time, timeValue(r.expiresAt));
      const conflict = [n.partition, n.key, n.windowStart].filter(Boolean).join(', ');
      values.push(r.maxAttempts);
      const max = `$${values.length}`;
      const sameWindow = n.expiresAt ? ` AND ${n.table}.${n.expiresAt} = EXCLUDED.${n.expiresAt}` : '';
      const sql = `INSERT INTO ${n.table} (${columns.join(', ')}, ${n.count}) VALUES (${placeholders.join(', ')}, 1)
        ON CONFLICT (${conflict}) DO UPDATE SET ${n.count} = ${n.table}.${n.count} + 1
        WHERE ${n.table}.${n.count} < ${max}${sameWindow} RETURNING ${n.count} AS attempts`;
      const result = await db.query(sql, values);
      const row = result.rows[0];
      return row === undefined ? { allowed: false, count: r.maxAttempts } : { allowed: true, count: Number(row.attempts) };
    },
    async count(w) {
      checkReservation(w, false);
      const values: unknown[] = [];
      const where: string[] = [];
      if (n.partition) {
        values.push(w.partition);
        where.push(`${n.partition} = $${values.length}`);
      }
      values.push(w.key);
      where.push(`${n.key} = $${values.length}`);
      values.push(timeValue(w.windowStart));
      where.push(`${n.windowStart} = ${time(values.length)}`);
      const result = await db.query(`SELECT ${n.count} AS attempts FROM ${n.table} WHERE ${where.join(' AND ')}`, values);
      return result.rows[0] === undefined ? 0 : Number(result.rows[0].attempts);
    },
    async deleteExpired(now, limit) {
      if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(limit) || limit < 1) {
        throw new FixedWindowError('invalid_attempt', 'Invalid rate limit cleanup');
      }
      const column = n.expiresAt ?? n.windowStart;
      const cutoff = n.expiresAt ? now : now - n.retainMs;
      const comparison = n.expiresAt ? '<=' : '<';
      const result = await db.query(
        `DELETE FROM ${n.table} WHERE ctid IN (SELECT ctid FROM ${n.table} WHERE ${column} ${comparison} ${time(1)} ORDER BY ${column} LIMIT $2)`,
        [timeValue(cutoff), limit],
      );
      return result.rowCount ?? 0;
    },
  };
}
