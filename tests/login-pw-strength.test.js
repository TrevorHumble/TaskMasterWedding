// tests/login-pw-strength.test.js
// AC4 + AC5: validateAdminPassword rejects short and denylisted passwords;
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

  it('rejects a ≥12-char denylisted password', () => {
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
