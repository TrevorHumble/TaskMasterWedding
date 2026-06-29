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

// A small inline denylist of passwords that are too common even if ≥12 chars.
const DENYLIST = new Set([
  '123456789012',
  'password123456',
  'qwertyuiop12',
  '111111111111',
  '000000000000',
  'aaaaaaaaaaaa',
]);

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
  if (DENYLIST.has(pw.toLowerCase())) {
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
