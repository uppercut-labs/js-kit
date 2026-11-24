import { bytesToHex, toBytes, WebhookError } from './bytes.js';
import type { Body } from './bytes.js';

export interface Receipt {
  /** Namespace such as a provider or endpoint. */
  readonly scope: string;
  /** The sender's event or delivery id. */
  readonly id: string;
  /** SHA-256 hex of the raw payload. */
  readonly digest: string;
  /** Epoch milliseconds. */
  readonly receivedAt: number;
}

/** Where receipts live. `putIfAbsent` must be atomic: two racing calls for one id cannot both insert. */
export interface ReceiptStore {
  putIfAbsent(receipt: Receipt): Promise<{ inserted: true } | { inserted: false; digest: string }>;
}

export type ReceiptStatus =
  /** First time this id was seen. Process the event. */
  | 'new'
  /** Seen before with the same payload. Acknowledge without processing again. */
  | 'duplicate'
  /** Seen before with a different payload. Do not process; the sender reused an id. */
  | 'conflict';

export interface ReceiptLedger {
  record(input: { scope: string; id: string; body?: Body; digest?: string; now?: number }): Promise<ReceiptStatus>;
}

export async function digestPayload(body: Body): Promise<string> {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', toBytes(body))));
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

/**
 * Remember which deliveries were received. Call after the signature verifies and before any side effect,
 * and let a storage error fail the request so the sender retries.
 */
export function createReceiptLedger(store: ReceiptStore): ReceiptLedger {
  return {
    async record({ scope, id, body, digest, now }) {
      if (typeof scope !== 'string' || !IDENTIFIER.test(scope) || typeof id !== 'string' || !IDENTIFIER.test(id)) {
        throw new WebhookError('invalid_input', 'scope and id must be 1 to 200 letters, digits or _ . : -');
      }
      const hash = digest ?? (body === undefined ? undefined : await digestPayload(body));
      if (hash === undefined || !/^[0-9a-f]{64}$/.test(hash)) throw new WebhookError('invalid_input', 'Provide the raw body or a SHA-256 hex digest');
      const result = await store.putIfAbsent({ scope, id, digest: hash, receivedAt: now ?? Date.now() });
      if (result.inserted) return 'new';
      return result.digest === hash ? 'duplicate' : 'conflict';
    },
  };
}

/** Process-local receipts, for tests and single-instance tools. */
export function createMemoryReceiptStore(): ReceiptStore & { readonly size: number } {
  const seen = new Map<string, string>();
  return {
    get size() {
      return seen.size;
    },
    async putIfAbsent(receipt) {
      const key = JSON.stringify([receipt.scope, receipt.id]);
      const existing = seen.get(key);
      if (existing !== undefined) return { inserted: false, digest: existing };
      seen.set(key, receipt.digest);
      return { inserted: true };
    },
  };
}
