// Smoke test: the test runner is wired and config loads. Real coverage lands
// in the dedicated test-suite PR (see the test plan).
//
// ISOLATION (#313): config.js and, transitively through scoring -> db, db.js
// both read/open data/app.db at REQUIRE time. process.env.DATA_DIR must be
// pointed at a temp dir before either module is required — including this
// file's own top-level requires — or the test process binds the live event
// database. See tests/helpers/testApp.js's loadApp() for the same pattern.
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-smoke-'));

const config = require('../config');
// autoBadgeThresholds() lives only in scoring.js (the single owner) — see
// issue #118. config.js no longer re-exports anything badge-threshold-
// shaped. Issue #1094 replaced the old BADGE_THRESHOLDS/AUTO_THRESHOLDS
// constants with this per-call DB read (the badges.threshold column is now
// the runtime source of truth), so this smoke test asserts the current
// export shape, not the retired one.
const scoring = require('../src/services/scoring');

describe('config', () => {
  it('exposes the keys the app depends on', () => {
    expect(typeof config.PORT).toBe('number');
    expect(config.COOKIE_SECRET).toBeTruthy();
    expect(config.DB_PATH).toContain('app.db');
    expect(Array.isArray(scoring.autoBadgeThresholds())).toBe(true);
    expect(scoring.BADGE_THRESHOLDS).toBeUndefined();
  });
});
