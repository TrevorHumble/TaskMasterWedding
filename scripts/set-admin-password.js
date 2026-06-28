// scripts/set-admin-password.js
// Hashes an admin password with bcryptjs and writes the hash to data/admin.hash.
//
// Usage (from the project root):
//   node scripts/set-admin-password.js ButtMonster
//
// To CHANGE the password later, just run it again with a new password:
//   node scripts/set-admin-password.js MyNewPassword
// It overwrites data/admin.hash. The old password stops working immediately.
//
// If you run it with no argument, it defaults to the wedding password.

const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('../config');

// The wedding default. Override by passing a password as the first argument.
const DEFAULT_PASSWORD = 'ButtMonster';

const password = process.argv[2] || DEFAULT_PASSWORD;

// Make sure the data directory exists (it may not on a fresh checkout).
if (!fs.existsSync(config.DATA_DIR)) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

// bcryptjs is synchronous-capable. 10 salt rounds is the agreed cost.
const hash = bcrypt.hashSync(password, 10);

fs.writeFileSync(config.ADMIN_HASH_PATH, hash, 'utf8');

console.log('Admin password set.');
console.log('Hash written to:', config.ADMIN_HASH_PATH);
if (password === DEFAULT_PASSWORD) {
  console.log('(Used the default wedding password.)');
}
