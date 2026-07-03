// Smoke test: the test runner is wired and config loads. Real coverage lands
// in the dedicated test-suite PR (see the test plan).
const config = require('../config');
// BADGE_THRESHOLDS lives only in scoring.js (the single owner) — see issue
// #118. config.js no longer re-exports it, so assert against the real owner.
const scoring = require('../src/services/scoring');

describe('config', () => {
  it('exposes the keys the app depends on', () => {
    expect(typeof config.PORT).toBe('number');
    expect(config.COOKIE_SECRET).toBeTruthy();
    expect(config.DB_PATH).toContain('app.db');
    expect(Array.isArray(scoring.BADGE_THRESHOLDS)).toBe(true);
  });
});
