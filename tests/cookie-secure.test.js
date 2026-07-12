// tests/cookie-secure.test.js
// AC-1: COOKIE_SECURE drives the Secure attribute on gsid, admin, and flash cookies.
// Toggle config.COOKIE_SECURE and confirm the Set-Cookie header matches.
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const { loadApp } = require('./helpers/testApp');

let app;
let config;

beforeAll(() => {
  const result = loadApp();
  app = result.app;

  // config is now cached with the temp DATA_DIR from loadApp().
  config = require('../config');

  // Write a known admin hash so POST /admin/login can succeed.
  fs.mkdirSync(path.dirname(config.ADMIN_HASH_PATH), { recursive: true });
  fs.writeFileSync(config.ADMIN_HASH_PATH, bcrypt.hashSync('CorrectHorse!3', 10), 'utf8');
});

afterAll(() => {
  // Always restore to the original value (false in NODE_ENV=test).
  config.COOKIE_SECURE = false;
});

describe('COOKIE_SECURE drives admin cookie Secure attribute (AC-1)', () => {
  it('with COOKIE_SECURE true: POST /admin/login Set-Cookie contains Secure', async () => {
    config.COOKIE_SECURE = true;
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!3' });

    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const adminCookie = cookies.find((c) => c.startsWith('admin='));
    expect(adminCookie).toBeTruthy();
    expect(adminCookie).toMatch(/;\s*Secure/i);
  });

  it('with COOKIE_SECURE false: POST /admin/login Set-Cookie does NOT contain Secure', async () => {
    config.COOKIE_SECURE = false;
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'CorrectHorse!3' });

    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const adminCookie = cookies.find((c) => c.startsWith('admin='));
    expect(adminCookie).toBeTruthy();
    expect(adminCookie).not.toMatch(/;\s*Secure/i);
  });
});

// Issue #244 retired GET /j/:token — it no longer sets any cookie (AC1), so
// the gsid Set-Cookie assertions below move to the two routes that still set
// it: POST /join (new-guest signup) and POST /login (re-entry).
describe('COOKIE_SECURE drives gsid cookie Secure attribute (AC-1)', () => {
  it('with COOKIE_SECURE true: POST /join Set-Cookie contains Secure', async () => {
    config.COOKIE_SECURE = true;
    const res = await request(app)
      .post('/join')
      .type('form')
      .send({ name: 'CS Guest', contact: 'cs-secure@example.com', pin: '1111' });

    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const gsidCookie = cookies.find((c) => c.startsWith('gsid='));
    expect(gsidCookie).toBeTruthy();
    expect(gsidCookie).toMatch(/;\s*Secure/i);
  });

  it('with COOKIE_SECURE false: POST /login Set-Cookie does NOT contain Secure', async () => {
    // Sign up first (with COOKIE_SECURE off) so a known contact/PIN exists to
    // re-enter with — POST /login is the assertion under test, not signup.
    config.COOKIE_SECURE = false;
    await request(app)
      .post('/join')
      .type('form')
      .send({ name: 'CS Guest Two', contact: 'cs-not-secure@example.com', pin: '2222' });

    const res = await request(app)
      .post('/login')
      .type('form')
      .send({ contact: 'cs-not-secure@example.com', pin: '2222' });

    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const gsidCookie = cookies.find((c) => c.startsWith('gsid='));
    expect(gsidCookie).toBeTruthy();
    expect(gsidCookie).not.toMatch(/;\s*Secure/i);
  });
});
