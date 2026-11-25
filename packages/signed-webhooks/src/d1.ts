import { WebhookError } from './bytes.js';
import type { Receipt, ReceiptStore } from './receipts.js';

/** The part of a Cloudflare D1 binding this store uses. */
export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = Record<string, unknown>>(): Promise<T | null>;
    };
  };
}

export interface D1ReceiptStoreOptions {
  /** Defaults to `webhook_receipts`. */
  readonly table?: string | undefined;
  readonly columns?: { readonly scope?: string | undefined; readonly id?: string | undefined; readonly digest?: string | undefined; readonly receivedAt?: string | undefined } | undefined;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
function quote(name: string): string {
  if (!NAME.test(name)) throw new WebhookError('invalid_input', 'Invalid table or column name');
  return `"${name}"`;
}

function names(options: D1ReceiptStoreOptions) {
  const c = options.columns ?? {};
  return {
    table: quote(options.table ?? 'webhook_receipts'),
    scope: quote(c.scope ?? 'scope'),
    id: quote(c.id ?? 'id'),
    digest: quote(c.digest ?? 'digest'),
    receivedAt: quote(c.receivedAt ?? 'received_at'),
  };
}

/** SQL that creates the receipt table in D1 (SQLite). Run it in a migration. */
export function d1ReceiptSchema(options: D1ReceiptStoreOptions = {}): string {
  const n = names(options);
  return `CREATE TABLE IF NOT EXISTS ${n.table} (
  ${n.scope} TEXT NOT NULL,
  ${n.id} TEXT NOT NULL,
  ${n.digest} TEXT NOT NULL,
  ${n.receivedAt} INTEGER NOT NULL,
  PRIMARY KEY (${n.scope}, ${n.id})
);`;
}

/**
 * Receipts in D1. One INSERT ... ON CONFLICT DO NOTHING decides who was first, so racing deliveries of one
 * event cannot both read "new". The primary key (or a unique index) must cover scope and id.
 */
export function createD1ReceiptStore(db: D1Like, options: D1ReceiptStoreOptions = {}): ReceiptStore {
  const n = names(options);
  const insert = `INSERT INTO ${n.table} (${n.scope},${n.id},${n.digest},${n.receivedAt}) VALUES(?,?,?,?)
    ON CONFLICT(${n.scope},${n.id}) DO NOTHING RETURNING ${n.digest} AS digest`;
  const select = `SELECT ${n.digest} AS digest FROM ${n.table} WHERE ${n.scope}=? AND ${n.id}=?`;
  return {
    async putIfAbsent(receipt: Receipt) {
      const inserted = await db.prepare(insert).bind(receipt.scope, receipt.id, receipt.digest, receipt.receivedAt).first<{ digest: string }>();
      if (inserted) return { inserted: true as const };
      const prior = await db.prepare(select).bind(receipt.scope, receipt.id).first<{ digest: string }>();
      if (!prior) throw new WebhookError('storage_conflict', 'Receipt disappeared before it could be read');
      return { inserted: false as const, digest: String(prior.digest) };
    },
  };
}
