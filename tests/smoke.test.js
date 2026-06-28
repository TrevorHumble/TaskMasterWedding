// Smoke test: the test runner is wired and config loads. Real coverage lands
// in the dedicated test-suite PR (see the test plan).
const config = require('../config');

describe('config', () => {
  it('exposes the keys the app depends on', () => {
    expect(typeof config.PORT).toBe('number');
    expect(config.COOKIE_SECRET).toBeTruthy();
    expect(config.DB_PATH).toContain('app.db');
    expect(Array.isArray(config.BADGE_THRESHOLDS)).toBe(true);
  });
});
