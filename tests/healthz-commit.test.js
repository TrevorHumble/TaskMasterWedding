// tests/healthz-commit.test.js
// Issue #562 AC1 ("the running app reports its commit") and AC2 (/healthz
// stays an additive, unauthenticated readiness probe). AC3/AC4/AC6 (the
// deploy script and the workflow trigger allowlist) are covered instead by
// tests/deploy-script.test.js.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let config;
let db;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  // config is now cached with the temp DATA_DIR from loadApp() (mirrors
  // tests/hosting-lifecycle.test.js's beforeAll).
  config = require('../config');
});

// Mirrors tests/hosting-lifecycle.test.js's reloadAppWithFreshConfig. Needed
// because config.js resolves every key at module load
// (`GIT_SHA: process.env.GIT_SHA || 'unknown'` is the same shape as PORT
// above it), so mutating the already-loaded config.GIT_SHA cannot exercise
// the `|| 'unknown'` DEFAULT itself — only re-requiring config from a clean
// require.cache, with the env var actually unset first, can.
function reloadAppWithFreshConfig() {
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../src/app')];
  return require('../src/app');
}

describe('GET /healthz reports the built commit (AC1)', () => {
  it('a SHA present at build time is echoed back on the success (200) path', async () => {
    // Mutate-config + afterEach-style restore, per tests/sample-photo-pool.test.js:27-31.
    const original = config.GIT_SHA;
    config.GIT_SHA = 'abc1234deadbeef00';
    try {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.commit).toBe('abc1234deadbeef00');
    } finally {
      config.GIT_SHA = original;
    }
  });

  it('no GIT_SHA supplied at build time -> the literal "unknown", never absent or fabricated', async () => {
    const saved = process.env.GIT_SHA;
    try {
      delete process.env.GIT_SHA;
      const freshApp = reloadAppWithFreshConfig();
      const res = await request(freshApp).get('/healthz');
      expect(res.status).toBe(200);
      // Guards against the exact regression AC1 calls out: a config.js
      // written `GIT_SHA: process.env.GIT_SHA` with no `|| 'unknown'`
      // fallback would serialize with the key DROPPED (JSON.stringify omits
      // an `undefined` property), passing a test that only checks
      // `!('commit' in res.body)` is false. Asserting the exact string
      // catches both failure shapes: absent, and any other fabricated value.
      expect(res.body.commit).toBe('unknown');
      expect('commit' in res.body).toBe(true);
    } finally {
      if (saved === undefined) {
        delete process.env.GIT_SHA;
      } else {
        process.env.GIT_SHA = saved;
      }
      // Reload once more so require.cache reflects the restored env, leaving
      // no stale unknown-GIT_SHA config cached for a later test file.
      reloadAppWithFreshConfig();
    }
  });
});

describe('GET /healthz carries commit on the 503 (DB-failure) path too (AC1 both-paths rule, AC2)', () => {
  it('a DB failure still returns 503, ok:false, AND the commit field', async () => {
    // Stub the shared db handle's prepare() to throw, reaching the catch
    // branch at src/app.js's /healthz route — mutating config alone cannot
    // get here, since the branch depends on the DB call throwing, not on any
    // config value.
    const originalPrepare = db.prepare;
    db.prepare = () => {
      throw new Error('simulated DB failure for #562 AC1/AC2 test');
    };
    try {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(503);
      expect(res.body.ok).toBe(false);
      expect(res.body.commit).toBe(config.GIT_SHA);
      expect(res.headers['content-type']).toContain('application/json');
    } finally {
      db.prepare = originalPrepare;
    }
  });

  it('the 503 path is unaffected otherwise: still ahead of maintenance mode', async () => {
    // AC2's "additive only" promise: the commit field must not have moved,
    // gated, or slowed down anything else about this route. Reuses the same
    // DB-throw stub plus MAINTENANCE=true (tests/hosting-lifecycle.test.js's
    // AC2 precedent) to confirm /healthz still answers rather than falling
    // through to the maintenance 503 page.
    const originalPrepare = db.prepare;
    db.prepare = () => {
      throw new Error('simulated DB failure');
    };
    config.MAINTENANCE = true;
    try {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ ok: false, commit: config.GIT_SHA });
    } finally {
      db.prepare = originalPrepare;
      config.MAINTENANCE = false;
    }
  });
});
