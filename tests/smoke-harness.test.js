// tests/smoke-harness.test.js
// Unit tests for the pure helpers exported by scripts/smoke.js (#197).
// The end-to-end smoke run itself is exercised by the CI `smoke` job, not
// here — these tests pin the helper contracts so the harness has coverage.
// (The existing tests/smoke.test.js is an unrelated config-keys test.)
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { cookieHeaderFrom, missingBadgeArt, summarize } = require('../scripts/smoke');

describe('cookieHeaderFrom', () => {
  it('keeps name=value pairs and drops cookie attributes', () => {
    const header = cookieHeaderFrom([
      'gsid=s%3Aabc.def; Max-Age=1209600; Path=/; HttpOnly; SameSite=Lax',
      'other=1; Path=/',
    ]);
    expect(header).toBe('gsid=s%3Aabc.def; other=1');
  });

  it('returns an empty string for no cookies', () => {
    expect(cookieHeaderFrom([])).toBe('');
    expect(cookieHeaderFrom(undefined)).toBe('');
  });

  it('ignores malformed entries without an = sign', () => {
    expect(cookieHeaderFrom(['garbage'])).toBe('');
  });
});

describe('missingBadgeArt', () => {
  it('reports rows whose /-rooted art file does not exist and passes rows whose file does', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-art-'));
    fs.mkdirSync(path.join(dir, 'badges'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'badges', 'bloom.svg'), '<svg/>');

    const missing = missingBadgeArt(
      [
        { code: 'BLOOM', art_path: '/badges/bloom.svg' },
        { code: 'COMPLETIONIST', art_path: '/badges/completionist.svg' },
      ],
      dir
    );
    expect(missing.map((b) => b.code)).toEqual(['COMPLETIONIST']);
  });

  it('skips non-path art values (emoji custom badges) and null art_path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-art-'));
    const missing = missingBadgeArt(
      [
        { code: 'PARTY', art_path: '🎉' },
        { code: 'NOART', art_path: null },
      ],
      dir
    );
    expect(missing).toEqual([]);
  });
});

describe('summarize', () => {
  it('exits 0 with all-pass lines when every check passed', () => {
    const { lines, exitCode } = summarize([
      { name: 'a', ok: true },
      { name: 'b', ok: true },
    ]);
    expect(exitCode).toBe(0);
    expect(lines).toContain('PASS a');
    expect(lines[lines.length - 1]).toBe('smoke: all 2 checks passed');
  });

  it('exits 1 and names the failing check with its detail', () => {
    const { lines, exitCode } = summarize([
      { name: 'a', ok: true },
      { name: 'b', ok: false, detail: 'got 500' },
    ]);
    expect(exitCode).toBe(1);
    expect(lines).toContain('FAIL b — got 500');
    expect(lines[lines.length - 1]).toBe('smoke: 1 of 2 checks FAILED');
  });
});
