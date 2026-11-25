import { describe, expect, it } from 'vitest';
import { buildCsp, cspOrigin, escapeCspSource, extendCsp, parseCsp, SecurityHeadersError } from '../src/index.js';
import { AUDIO_ORIGIN, CHECK_ORIGIN, COVER_ORIGIN, referenceAppPolicy, referenceEscape, referenceFamily, referenceSitePolicy, WIDGET_ORIGIN } from './references.js';

describe('buildCsp', () => {
  it('joins directives in the order written', () => {
    expect(buildCsp({ 'default-src': "'self'", 'img-src': ["'self'", 'data:', 'blob:'], 'object-src': "'none'" })).toBe("default-src 'self'; img-src 'self' data: blob:; object-src 'none'");
    expect(buildCsp({})).toBe('');
  });

  it('splits string sources on spaces, drops duplicates and blanks, writes bare directives', () => {
    expect(buildCsp({ 'script-src': "  'self'   https://a.example.test 'self' ", 'upgrade-insecure-requests': true })).toBe("script-src 'self' https://a.example.test; upgrade-insecure-requests");
    expect(buildCsp({ 'img-src': [], 'font-src': '' })).toBe('img-src; font-src');
  });

  it('leaves out false, null and undefined directives', () => {
    expect(buildCsp({ 'default-src': "'self'", 'img-src': false, 'font-src': null, 'media-src': undefined })).toBe("default-src 'self'");
  });

  it('refuses a source that could end the directive, add a policy or break the header', () => {
    for (const bad of ["'self'; script-src *", 'https://a.example.test, default-src *', 'a\nb', 'a\rb', 'a\u0000b']) {
      expect(() => buildCsp({ 'img-src': [bad] }), JSON.stringify(bad)).toThrow(SecurityHeadersError);
    }
    expect(() => buildCsp({ 'img-src': "'self'; script-src *" })).toThrow(SecurityHeadersError);
  });

  it('refuses a bad directive name', () => {
    for (const name of ['', 'Img-Src', 'img src', 'img-src;x', '1img']) expect(() => buildCsp({ [name]: "'self'" })).toThrow(SecurityHeadersError);
  });
});

describe('extendCsp and parseCsp', () => {
  const base = { 'default-src': "'none'", 'img-src': "'self'", 'frame-src': "'none'" };

  it('appends to a directive, adds a missing one and drops the duplicates', () => {
    expect(buildCsp(extendCsp(base, { 'img-src': ["'self'", 'https://img.example.test'], 'media-src': 'https://audio.example.test' }))).toBe(
      "default-src 'none'; img-src 'self' https://img.example.test; frame-src 'none'; media-src https://audio.example.test",
    );
  });

  it("drops 'none' when sources are added to that directive, and keeps it otherwise", () => {
    expect(buildCsp(extendCsp(base, { 'frame-src': 'https://player.example.test' }))).toContain("frame-src https://player.example.test");
    expect(buildCsp(extendCsp(base, { 'frame-src': 'https://player.example.test' }))).not.toContain("frame-src 'none'");
    expect(buildCsp(extendCsp(base, { 'frame-src': [] }))).toContain("frame-src 'none'");
    expect(buildCsp(extendCsp(base, {}))).toBe(buildCsp(base));
  });

  it('takes a policy string as the base', () => {
    expect(buildCsp(extendCsp("default-src 'self'; img-src 'self'", { 'img-src': 'data:' }))).toBe("default-src 'self'; img-src 'self' data:");
  });

  it('parses a policy, lower-casing names and keeping the first of a repeat', () => {
    expect(parseCsp("Default-Src 'self'; img-src 'self' data:; img-src *; upgrade-insecure-requests; ;")).toEqual({
      'default-src': ["'self'"],
      'img-src': ["'self'", 'data:'],
      'upgrade-insecure-requests': [],
    });
    expect(buildCsp(parseCsp(referenceSitePolicy('https://api.example.test')))).toBe(referenceSitePolicy('https://api.example.test'));
  });
});

describe('cspOrigin and escapeCspSource', () => {
  it('reduces a URL to its origin and treats blank as nothing', () => {
    expect(cspOrigin(' https://api.example.test:8443/v1/x?y=1#z ')).toBe('https://api.example.test:8443');
    expect(cspOrigin('http://localhost:8787/path')).toBe('http://localhost:8787');
    for (const blank of ['', '   ', undefined, null]) expect(cspOrigin(blank)).toBe('');
  });

  it('throws for what is not an http(s) URL', () => {
    for (const bad of ['api.example.test', 'ftp://x.example.test', 'javascript:alert(1)', 'https://']) expect(() => cspOrigin(bad), bad).toThrow(SecurityHeadersError);
  });

  it('percent-encodes characters that cannot sit in a source', () => {
    const url = 'https://id.example.test/end;session,x y';
    expect(escapeCspSource(url)).toBe('https://id.example.test/end%3Bsession%2Cx%20y');
    expect(buildCsp({ 'form-action': ["'self'", escapeCspSource(url)] })).toBe("form-action 'self' https://id.example.test/end%3Bsession%2Cx%20y");
    // Matches the two replacements the old code made, for URLs without spaces.
    expect(escapeCspSource('https://id.example.test/a;b,c')).toBe(referenceEscape('https://id.example.test/a;b,c'));
  });
});

describe('beside the policies it replaces', () => {
  it('builds the same site policy from an API base, with and without one', () => {
    const build = (apiBase: string) => {
      const api = cspOrigin(apiBase);
      const withApi = (...first: string[]) => [...first, ...(api ? [api] : [])];
      return buildCsp({
        'default-src': "'self'",
        'connect-src': withApi("'self'").concat('https://cdn.example.test'),
        'img-src': withApi("'self'", 'data:', 'blob:'),
        'style-src': ["'self'", "'unsafe-inline'"],
        'font-src': ["'self'", 'https://cdn.example.test'],
        'frame-ancestors': "'none'",
        'base-uri': "'self'",
        'object-src': "'none'",
      });
    };
    for (const apiBase of ['', '   ', 'https://api.example.test', ' https://api.example.test:8443/v1/ ', 'http://localhost:8787']) {
      expect(build(apiBase), JSON.stringify(apiBase)).toBe(referenceSitePolicy(apiBase));
    }
  });

  it('builds the Worker app policy with and without a logout target', () => {
    const build = (logout?: string) =>
      buildCsp({
        'default-src': "'none'",
        'script-src': "'self'",
        'style-src': "'self'",
        'img-src': "'self'",
        'font-src': "'self'",
        'connect-src': "'self'",
        'form-action': logout ? ["'self'", escapeCspSource(logout)] : "'self'",
        'base-uri': "'none'",
        'frame-ancestors': "'none'",
      });
    expect(build()).toBe(referenceAppPolicy());
    for (const logout of ['https://id.example.test/logout', 'https://id.example.test/oauth2/end-session']) expect(build(logout)).toBe(referenceAppPolicy(logout));
  });

  it('derives the per-route family from one base with extendCsp', () => {
    const app = {
      'default-src': "'none'",
      'script-src': "'self'",
      'style-src': "'self'",
      'font-src': "'self'",
      'img-src': "'self'",
      'connect-src': "'self'",
      'base-uri': "'none'",
      'form-action': "'self'",
      'frame-ancestors': "'none'",
      'object-src': "'none'",
    };
    expect(buildCsp(app)).toBe(referenceFamily.app);
    const cover = extendCsp(app, { 'img-src': COVER_ORIGIN });
    expect(buildCsp(cover)).toBe(referenceFamily.cover);
    expect(buildCsp(extendCsp(cover, { 'frame-src': WIDGET_ORIGIN }))).toBe(referenceFamily.media.replace(/; frame-src [^;]*$/, '') + `; frame-src ${WIDGET_ORIGIN}`);
    const playback = extendCsp(extendCsp(cover, { 'frame-src': WIDGET_ORIGIN, 'media-src': AUDIO_ORIGIN }), { 'connect-src': [AUDIO_ORIGIN, CHECK_ORIGIN] });
    // Same sources on every directive; only the directive order differs from the hand-spliced string.
    expect(parseCsp(buildCsp(playback))).toEqual(parseCsp(referenceFamily.playback));
    expect(parseCsp(buildCsp(extendCsp(cover, { 'frame-src': WIDGET_ORIGIN })))).toEqual(parseCsp(referenceFamily.media));
  });
});
