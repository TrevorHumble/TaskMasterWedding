// tests/admin-design.test.js
// AC3 + AC4 from issue #32: single <main>, admin pages render on-brand.
'use strict';

const { loadApp, seed, makeAdminAgent } = require('./helpers/testApp');
const request = require('supertest');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  seed(db);
  adminAgent = await makeAdminAgent(app);
});

describe('admin design system — AC3: single <main> preserved', () => {
  it('unauthenticated GET /admin/login returns 200 with exactly one <main', async () => {
    const res = await request(app).get('/admin/login');
    expect(res.status).toBe(200);
    const count = (res.text.match(/<main/g) || []).length;
    expect(count).toBe(1);
  });

  it('authenticated GET /admin returns 200 with exactly one <main', async () => {
    const res = await adminAgent.get('/admin');
    expect(res.status).toBe(200);
    const count = (res.text.match(/<main/g) || []).length;
    expect(count).toBe(1);
  });
});

describe('admin design system — AC4: admin pages render with a session', () => {
  // /admin/qrsheet -> /admin/poster (issue #244 retired the per-guest QR sheet).
  const routes = ['/admin', '/admin/tasks', '/admin/guests', '/admin/photos', '/admin/poster'];

  routes.forEach((route) => {
    // Issue #252 self-hosted every font (no more per-page Google Fonts link);
    // EB Garamond's @font-face now lives in theme.css, so "renders on-brand"
    // is now verified by the theme.css stylesheet link being present.
    it(`GET ${route} returns 200 and links theme.css`, async () => {
      const res = await adminAgent.get(route);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<link rel="stylesheet" href="/css/theme.css">');
    });
  });
});
