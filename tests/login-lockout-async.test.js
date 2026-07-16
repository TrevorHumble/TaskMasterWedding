// tests/login-lockout-async.test.js
// Verifies that switching compareSync → async compare preserves the #49 invariant:
// a correct password authenticates and clears the lockout even while it is active,
// and a wrong password during the lockout still returns 429.
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const request = require('supertest');

// Set env overrides BEFORE loadApp() so config picks them up on first require.
process.env.ADMIN_LOGIN_MAX_ATTEMPTS = '3';

const { loadApp } = require('./helpers/testApp');

let app;
let hashPath;

beforeAll(() => {
  const result = loadApp();
  app = result.app;

  // Require config only after loadApp() — it is now cached with the temp DATA_DIR.
  const config = require('../config');
  hashPath = config.ADMIN_HASH_PATH;

  // Write a known hash directly — do NOT use makeAdminAgent (it burns one attempt).
  fs.mkdirSync(path.dirname(hashPath), { recursive: true });
  fs.writeFileSync(hashPath, bcrypt.hashSync('CorrectHorse!71', 10), 'utf8');
});

describe('async compare preserves #49 invariant', () => {
  it('correct password during active lockout → 302 with admin cookie and lockout cleared', async () => {
    // Reach the threshold with wrong attempts so lockedUntil is in the future.
    for (let i = 0; i < 3; i++) {
      await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });
    }

    // Correct password while lockout is active — must authenticate.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!71' });

    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    expect(cookies.some((c) => c.startsWith('admin='))).toBe(true);

    // Lockout was cleared: a subsequent wrong attempt must NOT immediately 429
    // (the counter was reset, so one wrong attempt is not yet at the threshold).
    const after = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'wrongpassword' });

    expect(after.status).toBe(401);
  });

  it('wrong password during active lockout → 429', async () => {
    // The previous test left the counter at 1; hit the threshold again.
    for (let i = 0; i < 2; i++) {
      await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });
    }

    // One more wrong attempt while the lockout is active.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'wrongpassword' });

    expect(res.status).toBe(429);
  });
});

// #283 AC5/AC6: the admin lockout counter now persists to SQLite via
// src/services/lockout.js instead of the module-scoped scalars this file's
// two tests above already exercise through the HTTP surface (unmodified —
// AC9). This new block appended after them exercises the SAME route through
// lockout.js's own state directly, plus AC5's "survives a restart" claim.
//
// Block-scoped reset: rather than depend on whatever failedAttempts/
// lockedUntil the two tests above left behind, each test here first calls
// lockout.clear() so its own Given clause starts from a known zero state.
describe('#283 AC5/AC6: admin lockout persists across a restart', () => {
  // NOTE: require lockout.js only INSIDE a hook/test body, never at
  // describe-body scope. vitest evaluates a describe() callback during
  // collection, before ANY beforeAll (including the file-level one above
  // that calls loadApp()) has run — requiring a db-backed module that early
  // would bind src/db.js's connection to the LIVE data/app.db (DATA_DIR not
  // yet overridden), not this file's isolated temp DB.
  let lockout;
  beforeAll(() => {
    lockout = require('../src/services/lockout');
  });

  it('AC5: recordFailure() persists to SQLite (readable via a fresh connection to the same file, simulating a new process), and clear() zeroes it', () => {
    const config = require('../config');
    const Database = require('better-sqlite3');

    lockout.clear();

    // Reach the lockout threshold (ADMIN_LOGIN_MAX_ATTEMPTS='3', set at the
    // top of this file) directly through the service.
    let state;
    for (let i = 0; i < 3; i++) {
      state = lockout.recordFailure();
    }
    expect(state.failedAttempts).toBe(0); // reset the moment the lockout engages
    expect(state.lockedUntil).toBeGreaterThan(Date.now());

    // Simulate a new process: open a SEPARATE connection to the same on-disk
    // file and read the row back through a freshly prepared statement — this
    // proves the state landed in SQLite, not a JS-only variable a new
    // process could never see.
    const freshDb = new Database(config.DB_PATH, { readonly: true });
    const row = freshDb
      .prepare(`SELECT value FROM settings WHERE key = ?`)
      .get('admin_lockout_locked_until');
    freshDb.close();

    expect(row).toBeDefined();
    expect(parseInt(row.value, 10)).toBe(state.lockedUntil);

    lockout.clear();
    expect(lockout.getState()).toEqual({ failedAttempts: 0, lockedUntil: 0 });
  });

  it('AC6: the correct password during an engaged lockout still authenticates, and lockout.getState() reflects the clear', async () => {
    lockout.clear();

    // Engage a lockout directly through the service (ADMIN_LOGIN_MAX_ATTEMPTS='3').
    for (let i = 0; i < 3; i++) {
      lockout.recordFailure();
    }
    expect(lockout.getState().lockedUntil).toBeGreaterThan(Date.now());

    // POST /admin/login's success branch runs bcrypt.compare FIRST,
    // unconditionally (issue #49) — a correct password wins even mid-lockout.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!71' });

    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    expect(cookies.some((c) => c.startsWith('admin='))).toBe(true);
    expect(lockout.getState()).toEqual({ failedAttempts: 0, lockedUntil: 0 });
  });
});
