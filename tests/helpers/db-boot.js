// tests/helpers/db-boot.js
// Single owner of the db-eviction PAIRING (issue #969 PR review fix): the
// db.js entry (src/db.js) and its connection singleton (src/db/connection.js)
// must always be evicted from require.cache TOGETHER before a test
// re-requires '../src/db' to force a real second boot -- evicting the entry
// alone leaves connection.js cached, so the "second boot" would silently
// reuse the FIRST boot's already-open handle instead of opening a real
// second connection (see tests/flash-migration.test.js's own header comment
// for the fully-worked-out hazard this guards against; that file, and every
// other class-4 migration test, now calls this instead of hand-writing the
// pair). Resolves both paths relative to THIS file, not relative to the
// caller, so every call site evicts the exact same two require.cache keys no
// matter which tests/*.js file calls it from.
'use strict';

const path = require('path');

const DB_ENTRY_PATH = path.join(__dirname, '..', '..', 'src', 'db');
const DB_CONNECTION_PATH = path.join(__dirname, '..', '..', 'src', 'db', 'connection');

/**
 * Evict src/db.js and src/db/connection.js from require.cache together. Call
 * this immediately before a test's next `require('../src/db')` (or
 * `require('../src/app')`, which itself requires '../db') that needs a real
 * second boot against a freshly-set DATA_DIR/DB_PATH, not the first boot's
 * already-migrated module object and open handle.
 */
function evictDbModules() {
  delete require.cache[require.resolve(DB_ENTRY_PATH)];
  delete require.cache[require.resolve(DB_CONNECTION_PATH)];
}

module.exports = { evictDbModules };
