// tests/login-lockout-engages.test.js
// AC1: after MAX_ATTEMPTS wrong passwords the lockout engages; the correct
// password still authenticates (302 + admin cookie), but a wrong password
// past the threshold is throttled (429).
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
  fs.writeFileSync(hashPath, bcrypt.hashSync('CorrectHorse!1', 10), 'utf8');
});

describe('login lockout engages (AC1)', () => {
  it('3 wrong attempts then the correct password → 302 with admin cookie', async () => {
    // 3 wrong attempts — lockout threshold reached.
    for (let i = 0; i < 3; i++) {
      await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });
    }

    // Correct password — must authenticate even though lockout is active.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!1' });

    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const hasAdminCookie = cookies.some((c) => c.startsWith('admin='));
    expect(hasAdminCookie).toBe(true);
  });

  it('wrong password past the threshold → 429 (brute-force throttling preserved)', async () => {
    // The previous test cleared the counter on correct-password success, so hit
    // the threshold again with wrong attempts before testing the 429 path.
    for (let i = 0; i < 3; i++) {
      await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });
    }

    // Another wrong password while lockout is active must be throttled.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'wrongpassword' });

    expect(res.status).toBe(429);
  });
});
