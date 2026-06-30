// tests/login-pw-strength.test.js
// AC4 + AC5: validateAdminPassword rejects short and pattern-weak passwords;
// COST is 12; bcrypt emits the $2a$12$ prefix (bcryptjs 2.4.3).
'use strict';

const bcrypt = require('bcryptjs');

// Safe to require — the run body is guarded by require.main === module.
const { validateAdminPassword, COST } = require('../scripts/set-admin-password');

describe('validateAdminPassword (AC4)', () => {
  it('rejects a short password (< 12 chars)', () => {
    const result = validateAdminPassword('shortpw');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects a ≥12-char denylisted password (legacy: 123456789012)', () => {
    const result = validateAdminPassword('123456789012');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('validateAdminPassword + COST (AC5)', () => {
  it('accepts a strong passphrase', () => {
    const result = validateAdminPassword('a-strong-passphrase');
    expect(result.ok).toBe(true);
  });

  it('COST is 12', () => {
    expect(COST).toBe(12);
  });

  it('bcrypt.hashSync with COST emits $2a$12$ prefix (bcryptjs 2.4.3)', () => {
    const hash = bcrypt.hashSync('x', COST);
    expect(hash).toMatch(/^\$2[ab]\$12\$/);
  });
});

describe('validateAdminPassword pattern check (AC-2)', () => {
  // All-same-character
  it('rejects aaaaaaaaaaaa (all same char)', () => {
    const result = validateAdminPassword('aaaaaaaaaaaa');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects 111111111111 (all same digit)', () => {
    const result = validateAdminPassword('111111111111');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // Fully monotonic ascending sequence
  it('rejects 0123456789012 (monotonic ascending)', () => {
    const result = validateAdminPassword('0123456789012');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // Common base after lower-case + trailing-digit strip (exact equality)
  it('rejects Password1234 (base "password" after strip)', () => {
    const result = validateAdminPassword('Password1234');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('rejects Welcome12345 (base "welcome" after strip)', () => {
    const result = validateAdminPassword('Welcome12345');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  // Must NOT over-reject
  it('accepts a-strong-passphrase (existing accept case, must stay green)', () => {
    const result = validateAdminPassword('a-strong-passphrase');
    expect(result.ok).toBe(true);
  });

  it('accepts another strong passphrase (correcthorse!battery)', () => {
    const result = validateAdminPassword('correcthorse!battery');
    expect(result.ok).toBe(true);
  });
});
