/**
 * Send transactional email through the Resend REST API with `fetch` only: message validation, an idempotency key, a timeout,
 * failures that never echo the provider's response, and a mock capture for tests. No dependencies.
 */
export { createMailer, isLiveKey, MailSendError } from './mailer.js';
export type { Mailer, MailerConfig } from './mailer.js';
export { bareAddress, createMailCapture } from './capture.js';
export type { MailCapture } from './capture.js';
export { escapeHtml } from './html.js';
export type { CapturedMail, MailAttachment, MailFailureReason, MailMessage, SendOptions, SendResult } from './types.js';
