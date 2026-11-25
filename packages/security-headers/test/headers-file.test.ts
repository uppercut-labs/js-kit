import { describe, expect, it } from 'vitest';
import { buildHeadersFile, SecurityHeadersError, setHeaderInHeadersFile } from '../src/index.js';
import { referenceWriteHeaders } from './references.js';

const FILE = `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'
  Cache-Control: public, max-age=0, must-revalidate

/assets/*
  Cache-Control: public, max-age=31536000, immutable
  Content-Security-Policy: default-src 'none'
`;

describe('buildHeadersFile', () => {
  it('writes a path line and indented headers per rule', () => {
    expect(
      buildHeadersFile([
        { path: '/*', headers: { Link: '</llms.txt>; rel="describedby"; type="text/plain"', 'X-Content-Type-Options': 'nosniff' } },
        { path: '/', headers: { Link: '</index.md>; rel="alternate"; type="text/markdown"' } },
      ]),
    ).toBe('/*\n  Link: </llms.txt>; rel="describedby"; type="text/plain"\n  X-Content-Type-Options: nosniff\n\n/\n  Link: </index.md>; rel="alternate"; type="text/markdown"\n');
  });

  it('refuses a line break in a path, name or value', () => {
    expect(() => buildHeadersFile([{ path: '/*\n/admin/*', headers: {} }])).toThrow(SecurityHeadersError);
    expect(() => buildHeadersFile([{ path: '/*', headers: { 'X-A': 'a\nSet-Cookie: b=1' } }])).toThrow(SecurityHeadersError);
    expect(() => buildHeadersFile([{ path: '/*', headers: { 'X-A\n': 'a' } }])).toThrow(SecurityHeadersError);
  });
});

describe('setHeaderInHeadersFile', () => {
  it('replaces the header in every rule that has it', () => {
    const out = setHeaderInHeadersFile(FILE, 'Content-Security-Policy', "default-src 'self'; img-src data:");
    expect(out.match(/Content-Security-Policy: .*/g)).toEqual(["Content-Security-Policy: default-src 'self'; img-src data:", "Content-Security-Policy: default-src 'self'; img-src data:"]);
    expect(out).toContain('Cache-Control: public, max-age=31536000, immutable');
  });

  it('can be limited to one path', () => {
    const out = setHeaderInHeadersFile(FILE, 'Content-Security-Policy', 'x', { path: '/assets/*' });
    expect(out.match(/Content-Security-Policy: .*/g)).toEqual(["Content-Security-Policy: default-src 'self'", 'Content-Security-Policy: x']);
  });

  it('matches names without regard to case, keeps the file\'s spelling and indentation', () => {
    const out = setHeaderInHeadersFile('/*\n\tcontent-security-policy: a\n', 'Content-Security-Policy', 'b');
    expect(out).toBe('/*\n\tcontent-security-policy: b\n');
  });

  it('throws when the header is missing, so a build cannot ship without it', () => {
    expect(() => setHeaderInHeadersFile('/*\n  X-A: 1\n', 'Content-Security-Policy', 'x')).toThrow(SecurityHeadersError);
    expect(() => setHeaderInHeadersFile(FILE, 'Content-Security-Policy', 'x', { path: '/nope/*' })).toThrow(SecurityHeadersError);
    expect(() => setHeaderInHeadersFile(FILE, 'Content-Security-Policy', 'x\ny')).toThrow(SecurityHeadersError);
  });

  it('matches the build step it replaces on a one-rule file', () => {
    const single = `/*\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: default-src 'self'; img-src 'self'\n  Cache-Control: public, max-age=0, must-revalidate\n\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n`;
    const policy = "default-src 'self'; connect-src 'self' https://api.example.test";
    expect(setHeaderInHeadersFile(single, 'Content-Security-Policy', policy)).toBe(referenceWriteHeaders(single, policy));
  });
});
