import type { AcquireResult, CounterStore, Reservation } from './types.js';

/** Process-local counters. For tests and single-instance tools; never share across instances. */
export function createMemoryStore(): CounterStore & { readonly size: number } {
  const windows = new Map<string, { count: number; expiresAt: number }>();
  const id = (partition: string, key: string, windowStart: number) => JSON.stringify([partition, key, windowStart]);
  return {
    get size() {
      return windows.size;
    },
    async tryAcquire(r: Reservation): Promise<AcquireResult> {
      const k = id(r.partition, r.key, r.windowStart);
      const row = windows.get(k);
      if (!row) {
        windows.set(k, { count: 1, expiresAt: r.expiresAt });
        return { allowed: true, count: 1 };
      }
      if (row.count >= r.maxAttempts || row.expiresAt !== r.expiresAt) return { allowed: false, count: row.count };
      row.count += 1;
      return { allowed: true, count: row.count };
    },
    async count(w) {
      return windows.get(id(w.partition, w.key, w.windowStart))?.count ?? 0;
    },
    async deleteExpired(now, limit) {
      const expired = [...windows.entries()].filter(([, row]) => row.expiresAt <= now).sort((a, b) => a[1].expiresAt - b[1].expiresAt).slice(0, limit);
      for (const [k] of expired) windows.delete(k);
      return expired.length;
    },
  };
}
