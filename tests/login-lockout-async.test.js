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
