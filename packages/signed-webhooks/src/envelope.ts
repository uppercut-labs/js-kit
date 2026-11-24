import { WebhookError } from './bytes.js';

export interface EnvelopeInput<Data = unknown> {
  readonly id: string;
  readonly type: string;
  /** ISO 8601 time the event happened. */
  readonly occurredAt: string;
  readonly data: Data;
  /** Extra top-level fields, placed between `occurred_at` and `data`. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

const RESERVED = new Set(['schema_version', 'event_id', 'event_type', 'occurred_at', 'data']);

/**
 * The body of an outbound delivery: `{ schema_version: 1, event_id, event_type, occurred_at, ...extra, data }`.
 * Key order is fixed so the same event always serializes, and signs, to the same bytes.
 */
export function buildEnvelope<Data>(input: EnvelopeInput<Data>) {
  for (const key of Object.keys(input.extra ?? {})) {
    if (RESERVED.has(key)) throw new WebhookError('invalid_input', `extra must not set ${key}`);
  }
  return {
    schema_version: 1 as const,
    event_id: input.id,
    event_type: input.type,
    occurred_at: input.occurredAt,
    ...input.extra,
    data: input.data,
  };
}
