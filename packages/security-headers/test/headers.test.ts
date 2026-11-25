import { describe, expect, it } from 'vitest';
import { applySecurityHeaders, SecurityHeadersError, securityHeaders } from '../src/index.js';
import { referenceSecureResponse } from './references.js';

const EDITION_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'";

describe('securityHeaders', () => {
  it('has safe defaults and no policy unless asked', () => {
    expect(securityHeaders()).toEqual({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'X-Frame-Options': 'DENY',
    });
  });

  it('takes a policy as a string or a directive map', () => {
    expect(securityHeaders({ csp: "default-src 'self'" })['Content-Security-Policy']).toBe("default-src 'self'");
    expect(securityHeaders({ csp: { 'default-src': "'self'", 'img-src': ['data:'] } })['Content-Security-Policy']).toBe("default-src 'self'; img-src data:");
    expect(securityHeaders({ csp: false })).not.toHaveProperty('Content-Security-Policy');
  });

  it('turns each header off or changes it', () => {
    const headers = securityHeaders({
      contentTypeOptions: false,
      referrerPolicy: 'strict-origin-when-cross-origin',
      permissionsPolicy: { camera: [], fullscreen: ['self'], geolocation: ['https://maps.example.test'] },
      frameOptions: 'SAMEORIGIN',
      hsts: { maxAgeSeconds: 31536000, includeSubDomains: true, preload: true },
      crossOriginOpenerPolicy: 'same-origin',
      crossOriginResourcePolicy: 'same-site',
      extra: { 'X-Robots-Tag': 'noindex, nofollow' },
    });
    expect(headers).toEqual({
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Permissions-Policy': 'camera=(), fullscreen=(self), geolocation=("https://maps.example.test")',
      'X-Frame-Options': 'SAMEORIGIN',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-site',
      'X-Robots-Tag': 'noindex, nofollow',
    });
    expect(Object.keys(securityHeaders({ referrerPolicy: false, permissionsPolicy: false, frameOptions: false }))).toEqual(['X-Content-Type-Options']);
    expect(securityHeaders({ hsts: { maxAgeSeconds: 0 } })['Strict-Transport-Security']).toBe('max-age=0');
  });

  it('refuses values that cannot be sent in a header', () => {
    expect(() => securityHeaders({ csp: "default-src 'self'\r\nSet-Cookie: x=1" })).toThrow(SecurityHeadersError);
    expect(() => securityHeaders({ referrerPolicy: 'no-referrer\n' })).toThrow(SecurityHeadersError);
    expect(() => securityHeaders({ extra: { 'X-A': 'café' } })).toThrow(SecurityHeadersError);
    expect(() => securityHeaders({ hsts: { maxAgeSeconds: -1 } })).toThrow(SecurityHeadersError);
    expect(() => securityHeaders({ hsts: { maxAgeSeconds: 1.5 } })).toThrow(SecurityHeadersError);
  });
});

describe('applySecurityHeaders', () => {
  const options = { csp: EDITION_CSP, frameOptions: false as const };

  it('sets the headers on a copy and passes status, status text and body through', async () => {
    const original = new Response('payload', { status: 201, statusText: 'Created', headers: { 'content-type': 'text/plain', 'x-keep': '1' } });
    const secured = applySecurityHeaders(original, options);
    expect(secured).not.toBe(original);
    expect(secured.status).toBe(201);
    expect(secured.statusText).toBe('Created');
    expect(await secured.text()).toBe('payload');
    expect(secured.headers.get('x-keep')).toBe('1');
    expect(secured.headers.get('content-security-policy')).toBe(EDITION_CSP);
    expect(secured.headers.has('x-frame-options')).toBe(false);
  });

  it('keeps a header the route already set, unless told to overwrite', () => {
    const page = new Response('x', { headers: { 'Content-Security-Policy': "default-src 'none'", 'Referrer-Policy': 'same-origin' } });
    const kept = applySecurityHeaders(page, options);
    expect(kept.headers.get('content-security-policy')).toBe("default-src 'none'");
    expect(kept.headers.get('referrer-policy')).toBe('same-origin');
    expect(kept.headers.get('x-content-type-options')).toBe('nosniff');
    const forced = applySecurityHeaders(page, options, { overwrite: true });
    expect(forced.headers.get('content-security-policy')).toBe(EDITION_CSP);
    expect(forced.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('works on a response whose headers are immutable', () => {
    const redirect = Response.redirect('https://example.test/next', 302);
    expect(applySecurityHeaders(redirect, options).headers.get('location')).toBe('https://example.test/next');
  });

  it('sends the same headers as the wrapper it replaces', async () => {
    const make = () => new Response('body', { status: 200, headers: { 'content-type': 'text/html' } });
    const mine = applySecurityHeaders(make(), options);
    const theirs = referenceSecureResponse(make());
    expect([...mine.headers].sort()).toEqual([...theirs.headers].sort());
    expect(await mine.text()).toBe(await theirs.text());
  });
});
