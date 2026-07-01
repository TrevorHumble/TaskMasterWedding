// tests/maintenance-mode.test.js
// AC1: MAINTENANCE off -> GET / responds normally (not 503).
// AC2: MAINTENANCE on  -> GET / returns 503, Retry-After header present,
//                         body contains the literal marker "We'll be right back".
// AC3: MAINTENANCE on  -> GET /admin/login is NOT 503.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let config;

beforeAll(() => {
  // process.env.MAINTENANCE is unset here — maintenance is off by default.
  const result = loadApp();
  app = result.app;
  // config is now cached; read it so we can toggle MAINTENANCE between tests.
  config = require('../config');
});

afterAll(() => {
  // Restore to the default so this file's side-effects do not leak to others.
  config.MAINTENANCE = false;
});

describe('AC1: maintenance off (default)', () => {
  it('GET / returns 403 (guest auth required) when MAINTENANCE is false', async () => {
    config.MAINTENANCE = false;
    const res = await request(app).get('/');
    expect(res.status).toBe(403);
  });
});

describe('AC2: maintenance on — guest routes', () => {
  beforeEach(() => {
    config.MAINTENANCE = true;
  });

  it('GET / returns 503', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(503);
  });

  it('GET / has a Retry-After header', async () => {
    const res = await request(app).get('/');
    expect(res.headers['retry-after']).toBeTruthy();
  });

  it('GET / body contains the literal string "We\'ll be right back"', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain("We'll be right back");
  });
});

describe('AC3: maintenance on — /admin stays reachable', () => {
  beforeAll(() => {
    config.MAINTENANCE = true;
  });

  it('GET /admin/login returns 200 and renders the login form', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    expect(res.text).toContain('password');
  });
});
