import initSqlJs from 'sql.js';
import { beforeEach, describe, expect, it } from 'vitest';
import { createD1ReceiptStore, createMemoryReceiptStore, createReceiptLedger, d1ReceiptSchema, digestPayload, WebhookError } from '../src/index.js';
import type { D1Like, ReceiptStore } from '../src/index.js';

async function fakeD1() {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  const db: D1Like & { exec(sql: string): void; rows(sql: string): Array<Record<string, unknown>>; fail: boolean } = {
    fail: false,
    exec: (sql) => void sqlite.exec(sql),
    rows(sql) {
      const stmt = sqlite.prepare(sql);
      const out: Array<Record<string, unknown>> = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      stmt.free();
      return out;
    },
    prepare(sql) {
      return {
        bind: (...values) => ({
          first: async <T>() => {
            if (db.fail) throw new Error('d1 unavailable');
            const stmt = sqlite.prepare(sql);
            stmt.bind(values as never[]);
            const row = stmt.step() ? (stmt.getAsObject() as T) : null;
            stmt.free();
            return row;
          },
        }),
      };
    },
  };
  return db;
}

describe('digestPayload', () => {
  it('is SHA-256 hex of the raw bytes', async () => {
    // printf 'abc' | openssl dgst -sha256
    expect(await digestPayload('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(await digestPayload(new TextEncoder().encode('abc'))).toBe(await digestPayload('abc'));
  });
});

describe('receipt ledger on the memory store', () => {
  it('says new, then duplicate for the same payload, conflict for a different one', async () => {
    const ledger = createReceiptLedger(createMemoryReceiptStore());
    expect(await ledger.record({ scope: 'billing', id: 'evt_1', body: '{"a":1}' })).toBe('new');
    expect(await ledger.record({ scope: 'billing', id: 'evt_1', body: '{"a":1}' })).toBe('duplicate');
    expect(await ledger.record({ scope: 'billing', id: 'evt_1', body: '{"a":2}' })).toBe('conflict');
    expect(await ledger.record({ scope: 'other', id: 'evt_1', body: '{"a":2}' })).toBe('new');
  });

  it('takes a precomputed digest and refuses input it cannot judge', async () => {
    const ledger = createReceiptLedger(createMemoryReceiptStore());
    const digest = await digestPayload('x');
    expect(await ledger.record({ scope: 's', id: 'a', digest })).toBe('new');
    expect(await ledger.record({ scope: 's', id: 'a', body: 'x' })).toBe('duplicate');
    await expect(ledger.record({ scope: 's', id: 'a' })).rejects.toBeInstanceOf(WebhookError);
    await expect(ledger.record({ scope: 's', id: 'a', digest: 'short' })).rejects.toBeInstanceOf(WebhookError);
    await expect(ledger.record({ scope: 'bad scope', id: 'a', digest })).rejects.toBeInstanceOf(WebhookError);
    await expect(ledger.record({ scope: 's', id: '', digest })).rejects.toBeInstanceOf(WebhookError);
  });

  it('lets exactly one of many racing deliveries be new', async () => {
    const ledger = createReceiptLedger(createMemoryReceiptStore());
    const results = await Promise.all(Array.from({ length: 20 }, () => ledger.record({ scope: 's', id: 'evt', body: 'same' })));
    expect(results.filter((r) => r === 'new')).toHaveLength(1);
    expect(results.filter((r) => r === 'duplicate')).toHaveLength(19);
  });

  it('fails closed when the store fails', async () => {
    const broken: ReceiptStore = { putIfAbsent: async () => { throw new Error('storage down'); } };
    await expect(createReceiptLedger(broken).record({ scope: 's', id: 'a', body: 'x' })).rejects.toThrow('storage down');
  });
});

describe('receipt ledger on D1', () => {
  let db: Awaited<ReturnType<typeof fakeD1>>;
  beforeEach(async () => {
    db = await fakeD1();
    db.exec(d1ReceiptSchema());
  });

  it('records, dedupes and detects reuse with different evidence', async () => {
    const ledger = createReceiptLedger(createD1ReceiptStore(db));
    expect(await ledger.record({ scope: 'provider', id: 'evt_9', body: 'one', now: 1000 })).toBe('new');
    expect(await ledger.record({ scope: 'provider', id: 'evt_9', body: 'one', now: 2000 })).toBe('duplicate');
    expect(await ledger.record({ scope: 'provider', id: 'evt_9', body: 'two', now: 3000 })).toBe('conflict');
    expect(db.rows('SELECT scope, id, received_at FROM webhook_receipts')).toEqual([{ scope: 'provider', id: 'evt_9', received_at: 1000 }]);
    expect(JSON.stringify(db.rows('SELECT * FROM webhook_receipts'))).not.toContain('one');
  });

  it('lets exactly one of many racing deliveries be new', async () => {
    const ledger = createReceiptLedger(createD1ReceiptStore(db));
    const results = await Promise.all(Array.from({ length: 20 }, () => ledger.record({ scope: 's', id: 'evt', body: 'same' })));
    expect(results.filter((r) => r === 'new')).toHaveLength(1);
  });

  it('works on a table with other names', async () => {
    db.exec('CREATE TABLE inbox (provider TEXT NOT NULL, event_id TEXT NOT NULL, payload_digest TEXT NOT NULL, got_at INTEGER NOT NULL, PRIMARY KEY (provider, event_id))');
    const ledger = createReceiptLedger(createD1ReceiptStore(db, { table: 'inbox', columns: { scope: 'provider', id: 'event_id', digest: 'payload_digest', receivedAt: 'got_at' } }));
    expect(await ledger.record({ scope: 'p', id: 'e', body: 'x' })).toBe('new');
    expect(await ledger.record({ scope: 'p', id: 'e', body: 'x' })).toBe('duplicate');
  });

  it('fails closed on a database error and rejects unsafe names', async () => {
    const ledger = createReceiptLedger(createD1ReceiptStore(db));
    db.fail = true;
    await expect(ledger.record({ scope: 's', id: 'a', body: 'x' })).rejects.toThrow('d1 unavailable');
    expect(() => createD1ReceiptStore(db, { table: 'x; DROP TABLE y' })).toThrow(WebhookError);
  });
});
