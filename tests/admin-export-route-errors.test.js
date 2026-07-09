// tests/admin-export-route-errors.test.js
// Issue #181: a pre-stream export failure must reach the Express error
// handler (500), not hang the socket or crash the process. admin.js's
// GET /admin/export only calls next(err) when !res.headersSent; this test
// forces buildSummaryBuffer's first query to throw before archiver has
// written any bytes, so res.headersSent is still false when the error hits.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
});

describe('GET /admin/export — pre-stream failure', () => {
  it('a throw inside buildSummaryBuffer before any bytes are sent returns 500', async () => {
    const originalPrepare = db.prepare.bind(db);
    const GUESTS_QUERY =
      'SELECT id, name, bonus_points, social_links, created_at FROM guests ORDER BY id';

    const spy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql === GUESTS_QUERY) {
        throw new Error('boom: forced pre-stream failure');
      }
      return originalPrepare(sql);
    });

    try {
      const res = await adminAgent.get('/admin/export');
      expect(res.status).toBe(500);
    } finally {
      spy.mockRestore();
    }
  });
});
