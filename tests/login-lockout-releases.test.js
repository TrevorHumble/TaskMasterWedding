// tests/login-lockout-releases.test.js
// AC3: after the lockout window elapses, the correct password is accepted again.
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const request = require('supertest');

// Set env overrides BEFORE loadApp() so config picks them up on first require.
process.env.ADMIN_LOGIN_MAX_ATTEMPTS = '3';
process.env.ADMIN_LOGIN_LOCKOUT_MS = '150';

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
  fs.writeFileSync(hashPath, bcrypt.hashSync('CorrectHorse!3', 10), 'utf8');
});

describe('lockout releases after window (AC3)', () => {
  it('3 wrong (lock), wait the window, correct password → 302', async () => {
    // 3 wrong attempts — triggers the 150 ms lockout.
    for (let i = 0; i < 3; i++) {
      await request(app).post('/admin/login').type('form').send({ password: 'wrongpassword' });
    }

    // Wait longer than the lockout window (250 ms gives the 150 ms window room to
    // expire even on a slow CI box without timing races).
    await new Promise((r) => setTimeout(r, 250));

    // Correct password — lockout should have expired.
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!3' });

    expect(res.status).toBe(302);
  });
}, 10000);
