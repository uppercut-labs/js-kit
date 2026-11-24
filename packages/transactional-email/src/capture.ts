import type { CapturedMail } from './types.js';

/** Where a mailer in test mode puts its mail instead of sending it. */
export interface MailCapture {
  /** Every captured message, oldest first. */
  readonly sent: readonly CapturedMail[];
  /** The newest captured message. */
  last(): CapturedMail | undefined;
  /** Captured messages with this recipient (compared without regard to case, and with `Name <a@b>` reduced to `a@b`). */
  to(address: string): CapturedMail[];
  clear(): void;
  /** Used by the mailer. */
  record(mail: Omit<CapturedMail, 'id' | 'sentAt'>): CapturedMail;
}

/** The address inside `Name <name@example.com>`, lower-cased. */
export function bareAddress(address: string): string {
  const match = /<([^<>]*)>\s*$/.exec(address);
  return (match?.[1] ?? address).trim().toLowerCase();
}

export function createMailCapture(): MailCapture {
  const sent: CapturedMail[] = [];
  let counter = 0;
  return {
    get sent() {
      return sent;
    },
    last: () => sent[sent.length - 1],
    to: (address) => sent.filter((mail) => mail.to.some((to) => bareAddress(to) === bareAddress(address))),
    clear: () => {
      sent.length = 0;
    },
    record: (mail) => {
      counter += 1;
      const captured: CapturedMail = { ...mail, id: `mock_${counter}`, sentAt: new Date().toISOString() };
      sent.push(captured);
      return captured;
    },
  };
}
