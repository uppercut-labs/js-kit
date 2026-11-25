export interface MailAttachment {
  readonly filename: string;
  /** Base64 text (what Resend takes). */
  readonly content: string;
  readonly contentType?: string | undefined;
}

export interface MailMessage {
  /** One address or a list. An address may be `Name <name@example.com>`. */
  readonly to: string | readonly string[];
  readonly subject: string;
  /** At least one of `text` and `html` is required. Send both when you can. */
  readonly text?: string | undefined;
  readonly html?: string | undefined;
  /** Overrides the mailer's `from`. */
  readonly from?: string | undefined;
  readonly replyTo?: string | readonly string[] | undefined;
  readonly cc?: string | readonly string[] | undefined;
  readonly bcc?: string | readonly string[] | undefined;
  /** Extra message headers. Names and values may not hold a line break. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly tags?: readonly { readonly name: string; readonly value: string }[] | undefined;
  readonly attachments?: readonly MailAttachment[] | undefined;
}

export interface SendOptions {
  /**
   * Resend keeps the first result for a key for 24 hours and answers a repeat with it, so a retry never sends twice.
   * Use a value that names the thing being sent (`order/<id>`), 1 to 256 printable ASCII characters.
   */
  readonly idempotencyKey?: string | undefined;
}

export type MailFailureReason =
  /** The message or the key was not valid; nothing was sent. */
  | 'invalid'
  /** No usable API key; nothing was sent. */
  | 'not_configured'
  /** Resend refused the message (a 4xx other than 408 and 429). A retry will not help until the message changes. */
  | 'rejected'
  /** Resend or the network failed, or Resend is rate limiting (5xx, 408, 429, a network error). A retry with the same key is safe. */
  | 'unavailable'
  /** The request did not finish in time. The message may or may not have been accepted; retry with the same key. */
  | 'timeout';

export type SendResult =
  | {
      readonly ok: true;
      /** Resend's message id; a `mock_` id when the mail was captured. Absent if Resend's answer held none. */
      readonly id?: string | undefined;
      /** The message went to a capture, not to Resend. */
      readonly captured: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: MailFailureReason;
      /** HTTP status when Resend answered. */
      readonly status?: number | undefined;
      /** A retry with the same idempotency key can succeed. */
      readonly retryable: boolean;
      /** A fixed sentence safe to log: never the provider's response, the key or an address. */
      readonly error: string;
    };

/** A message as the capture recorded it, with every address as a list. */
export interface CapturedMail {
  readonly id: string;
  readonly sentAt: string;
  readonly from: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly replyTo: readonly string[];
  readonly subject: string;
  readonly text?: string | undefined;
  readonly html?: string | undefined;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly tags?: readonly { readonly name: string; readonly value: string }[] | undefined;
  readonly attachments: readonly MailAttachment[];
  readonly idempotencyKey?: string | undefined;
}
