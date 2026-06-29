// tests/login-under-limit.test.js
// AC2: 2 wrong attempts then the correct password → 302 + admin cookie.
// A subsequent wrong attempt does not lock (success reset the counter).
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
  fs.writeFileSync(hashPath, bcrypt.hashSync('CorrectHorse!2', 10), 'utf8');
});

describe('login under the limit (AC2)', () => {
  it('2 wrong then correct → 302 with admin cookie', async () => {
    // 2 wrong attempts (one below limit of 3).
    await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });
    await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });

    // Correct password — should succeed.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!2' });

    expect(res.status).toBe(302);
    // At least one Set-Cookie header must contain "admin".
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const hasAdminCookie = cookies.some((c) => c.startsWith('admin='));
    expect(hasAdminCookie).toBe(true);
  });

  it('wrong attempt after a success does not immediately lock (counter was reset)', async () => {
    // One more wrong attempt — counter should be 1, not at threshold 3, so 401.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'wrongpassword' });

    expect(res.status).toBe(401);
  });
});
