// tests/admin-design.test.js
// AC3 + AC4 from issue #32: single <main>, admin pages render on-brand.
'use strict';

const { loadApp, seed, makeAdminAgent } = require('./helpers/testApp');
const { themeSheetNames } = require('./helpers/theme-css');
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
    // EB Garamond's @font-face now lives in base.css, so "renders on-brand"
    // is now verified by the theme stylesheet link SET being present. Issue
    // #969 split theme.css into slices (base/guest/feed/admin/admin-tasks.css),
    // linked as five plain <link> tags in head.ejs -- assert the whole set,
    // in that order, not the single retired theme.css link.
    it(`GET ${route} returns 200 and links every theme stylesheet slice`, async () => {
      const res = await adminAgent.get(route);
      expect(res.status).toBe(200);
      expect(res.text).toContain('<link rel="stylesheet" href="/css/base.css">');
      expect(res.text).toContain('<link rel="stylesheet" href="/css/guest.css">');
      expect(res.text).toContain('<link rel="stylesheet" href="/css/feed.css">');
      expect(res.text).toContain('<link rel="stylesheet" href="/css/admin.css">');
      expect(res.text).toContain('<link rel="stylesheet" href="/css/admin-tasks.css">');
    });

    // PR review fix: the assertions above only prove each slice's <link> is
    // PRESENT, not that they're in the right ORDER -- and order is exactly
    // what makes the split cascade-correct (DESIGN.md's #969 section,
    // "cascade-safe by construction, not by content"). Cross-checks against
    // themeSheetNames() (tests/helpers/theme-css.js), which parses this same
    // head.ejs for its own order, rather than hard-coding a second copy of
    // the five names here that could drift from the real link set.
    it(`GET ${route} links every theme stylesheet slice in head.ejs's own order`, async () => {
      const res = await adminAgent.get(route);
      expect(res.status).toBe(200);
      const names = themeSheetNames();
      const indexes = names.map((name) =>
        res.text.indexOf(`<link rel="stylesheet" href="/css/${name}">`)
      );
      indexes.forEach((idx, i) => {
        expect(idx).toBeGreaterThan(-1);
        if (i > 0) {
          expect(idx).toBeGreaterThan(indexes[i - 1]);
        }
      });
    });
  });
});
