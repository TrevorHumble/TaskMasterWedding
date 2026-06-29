// tests/login-lockout-engages.test.js
// AC1: after MAX_ATTEMPTS wrong passwords the lockout engages and even the
// correct password is rejected with 429.
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
  it('3 wrong attempts then the correct password → 429', async () => {
    // 3 wrong attempts
    for (let i = 0; i < 3; i++) {
      await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });
    }

    // Correct password — must be rejected because lockout is now active.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!1' });

    expect(res.status).toBe(429);
  });
});
