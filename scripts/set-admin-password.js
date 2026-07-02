// scripts/set-admin-password.js
// Hashes an admin password with bcryptjs and writes the hash to data/admin.hash.
//
// Usage (from the project root):
//   node scripts/set-admin-password.js <password>
//
// To CHANGE the password later, just run it again with a new password:
//   node scripts/set-admin-password.js <password>
// It overwrites data/admin.hash. The old password stops working immediately.

'use strict';

const fs = require('fs');
const bcrypt = require('bcryptjs');

// bcrypt cost factor. 12 makes each hash attempt ~250 ms — feasible for a
// one-time script, infeasible for sustained brute-force.
const COST = 12;

// Common password bases that are too obvious even with trailing digits.
// The check lowercases the input and strips any trailing digits before
// comparing, so Password1234 and welcome99 both match 'password' / 'welcome'.
const COMMON_BASES = new Set(['password', 'welcome', 'admin', 'letmein', 'qwerty']);

/**
 * True when every character in the string is the same (e.g. 'aaaaaa', '111111').
 * @param {string} s
 * @returns {boolean}
 */
function isAllSameChar(s) {
  return s.split('').every(function (c) {
    return c === s[0];
  });
}

/**
 * True when the WHOLE string is a monotonic run — either:
 * (a) strictly ascending or descending by code point (e.g. 'abcdefghijkl'), or
 * (b) a string of digits where every digit differs from the previous by exactly
 *     +1 or -1 mod 10 (cyclic digit sequences: '0123456789012', '9876543210987').
 *
 * Sequences shorter than 3 are not considered monotonic.
 * @param {string} s
 * @returns {boolean}
 */
function isMonotonicRun(s) {
  if (s.length < 3) return false;
  const codes = s.split('').map(function (c) {
    return c.charCodeAt(0);
  });

  // Case (a): strictly monotonic by code point.
  const step = Math.sign(codes[1] - codes[0]);
  if (step !== 0) {
    let monotonic = true;
    for (let i = 1; i < codes.length; i++) {
      if (Math.sign(codes[i] - codes[i - 1]) !== step) {
        monotonic = false;
        break;
      }
    }
    if (monotonic) return true;
  }

  // Case (b): all-digit cyclic sequence (each digit ±1 mod 10 from previous).
  if (/^\d+$/.test(s)) {
    const digits = s.split('').map(Number);
    const dStep = (digits[1] - digits[0] + 10) % 10 === 1 ? 1 : -1;
    // Verify dStep is valid: first step must be exactly +1 or -1 mod 10.
    const firstStep = (digits[1] - digits[0] + 10) % 10;
    if (firstStep === 1 || firstStep === 9) {
      let cyclic = true;
      for (let i = 1; i < digits.length; i++) {
        const diff = (digits[i] - digits[i - 1] + 10) % 10;
        const expected = dStep === 1 ? 1 : 9;
        if (diff !== expected) {
          cyclic = false;
          break;
        }
      }
      if (cyclic) return true;
    }
  }

  return false;
}

/**
 * Validate an admin password without any file I/O.
 * Returns { ok: true } or { ok: false, error: string }.
 *
 * @param {string} pw
 * @returns {{ ok: boolean, error?: string }}
 */
function validateAdminPassword(pw) {
  if (!pw || pw.length < 12) {
    return { ok: false, error: 'Password must be at least 12 characters.' };
  }
  if (isAllSameChar(pw)) {
    return { ok: false, error: 'Password cannot be all the same character.' };
  }
  if (isMonotonicRun(pw)) {
    return { ok: false, error: 'Password cannot be a simple ascending or descending sequence.' };
  }
  // Strip trailing digits then compare exact lowercase base against common words.
  const base = pw.toLowerCase().replace(/\d+$/, '');
  if (COMMON_BASES.has(base)) {
    return { ok: false, error: 'Password is too common. Choose a more unique passphrase.' };
  }
  return { ok: true };
}

// Guard the run body so requiring this file has no side effects.
if (require.main === module) {
  const config = require('../config');

  const pw = process.argv[2];

  if (!pw) {
    console.error('Usage: node scripts/set-admin-password.js <password>');
    process.exit(1);
  }

  const result = validateAdminPassword(pw);
  if (!result.ok) {
    console.error('Error:', result.error);
    process.exit(1);
  }

  // Make sure the data directory exists (it may not on a fresh checkout).
  if (!fs.existsSync(config.DATA_DIR)) {
    fs.mkdirSync(config.DATA_DIR, { recursive: true });
  }

  const hash = bcrypt.hashSync(pw, COST);

  fs.writeFileSync(config.ADMIN_HASH_PATH, hash, 'utf8');

  console.log('Admin password set.');
  console.log('Hash written to:', config.ADMIN_HASH_PATH);
}

module.exports = { validateAdminPassword, COST };
