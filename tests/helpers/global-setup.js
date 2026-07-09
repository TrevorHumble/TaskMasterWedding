// tests/helpers/global-setup.js
// Vitest globalSetup (#313): a mechanical, always-on guard against the class
// of defect this issue fixed in tests/smoke.test.js — a test process that
// requires config/db without a DATA_DIR override binds to, and mutates, the
// LIVE data/app.db. This does not rely on any test file behaving correctly;
// it records the state of the real db files before the suite runs and fails
// the run if that state changed, no matter which test caused it.
//
// API CONFIRMED against installed vitest 4.1.9 (npx vitest --version) by a
// throwaway spike, not from memory:
//   - A CJS globalSetup file's default export is called as `setup(project)`
//     and its return value is used as `teardown()` (named `setup`/`teardown`
//     exports also work, but `module.exports = {setup, teardown}` collides
//     with Vite's CJS/ESM interop and is misread as an invalid default
//     export — the default-export-returns-teardown form given in vitest's
//     own docs is what actually works).
//   - A teardown function that THROWS does not fail the run: vitest catches
//     it in Vitest.close(), logs "error during close", and leaves
//     process.exitCode untouched (confirmed exit code 0 with a throwing
//     teardown and an otherwise-passing suite). Teardown must set
//     process.exitCode = 1 itself to fail `npm test`.
'use strict';

const fs = require('fs');
const config = require('../../config');

// better-sqlite3's WAL journal mode (see src/db.js) creates these two
// sidecar files alongside the main db file; all three must stay untouched.
const WATCHED_PATHS = [config.DB_PATH, `${config.DB_PATH}-wal`, `${config.DB_PATH}-shm`];

/**
 * mtimeMs for each watched path, or null for a path that does not exist.
 * Returning null instead of throwing is what makes the guard no-op cleanly
 * on a fresh checkout with no data/ dir yet (AC3) instead of crashing setup.
 */
function snapshot() {
  return WATCHED_PATHS.map((filePath) => {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  });
}

module.exports = async function setup() {
  const before = snapshot();

  return async function teardown() {
    const after = snapshot();
    const changed = WATCHED_PATHS.filter((_, i) => after[i] !== before[i]);

    if (changed.length > 0) {
      console.error(
        `[global-setup] data/ integrity guard failed: ${changed.join(', ')} ` +
          'changed (or was created) during the test run. A test opened or ' +
          'wrote the LIVE database instead of an isolated temp DATA_DIR ' +
          '(see tests/helpers/testApp.js loadApp()). See issue #313.'
      );
      // Throwing here would only be logged, not fail the run — see the API
      // note above. Setting exitCode directly is the confirmed-working path.
      process.exitCode = 1;
    }
  };
};
