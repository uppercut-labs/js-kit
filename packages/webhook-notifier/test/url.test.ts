import { describe, expect, it } from 'vitest';
import { redactWebhookUrl, webhookKind } from '../src/index.js';
import { DISCORD_URL, SLACK_URL } from './helpers.js';

describe('webhookKind', () => {
  it('recognizes Discord and Slack webhook URLs', () => {
    expect(webhookKind(DISCORD_URL)).toBe('discord');
    expect(webhookKind('https://ptb.discord.com/api/v10/webhooks/1/abc_DEF-1')).toBe('discord');
    expect(webhookKind('https://discordapp.com/api/webhooks/1/abc/')).toBe('discord');
    expect(webhookKind(SLACK_URL)).toBe('slack');
    expect(webhookKind('https://hooks.slack.com/workflows/T1/A1/123/abc')).toBe('slack');
  });

  it('refuses everything else', () => {
    for (const value of [
      'http://discord.com/api/webhooks/1/abc',
      'https://discord.com.example.test/api/webhooks/1/abc',
      'https://user:pass@discord.com/api/webhooks/1/abc',
      'https://discord.com:8443/api/webhooks/1/abc',
      'https://discord.com/api/webhooks/abc/abc',
      'https://discord.com/api/channels/1/messages',
      'https://hooks.slack.com/',
      'https://hooks.slack.com.example.test/services/T/B/c',
      'https://example.test/hook',
      'not a url',
      '',
    ]) expect(webhookKind(value), value).toBeNull();
  });
});

describe('redactWebhookUrl', () => {
  it('hides the secret part and keeps the service and id', () => {
    expect(redactWebhookUrl(DISCORD_URL)).toBe('https://discord.com/api/webhooks/123456789012345678/[redacted]');
    expect(redactWebhookUrl(`${DISCORD_URL}?wait=true`)).toBe('https://discord.com/api/webhooks/123456789012345678/[redacted]');
    expect(redactWebhookUrl(SLACK_URL)).toBe('https://hooks.slack.com/services/[redacted]');
    expect(redactWebhookUrl('https://example.test/hook?token=abc')).toBe('[redacted webhook url]');
    expect(redactWebhookUrl('garbage')).toBe('[redacted webhook url]');
    for (const url of [DISCORD_URL, SLACK_URL]) expect(redactWebhookUrl(url)).not.toMatch(/synthetic/i);
  });
});
