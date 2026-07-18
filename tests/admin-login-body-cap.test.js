// tests/admin-login-body-cap.test.js
// Issue #553: both body parsers in src/app.js (express.urlencoded,
// express.json) carry an explicit 16kb limit, and an over-limit body is
// refused with 413 BEFORE bcrypt.compare ever runs (AC1-AC3) -- not the 500
// the catch-all error handler would otherwise render for a body-parser
// PayloadTooLargeError. A legitimate-size body -- the largest real text
// field in src/views/, the bug-report textarea (maxlength="1000",
// src/views/bug-report.ejs:24) -- still succeeds (AC4).
//
// Drives the real app over supertest/HTTP, unlike the sibling
// tests/admin-login-cpu-bound.test.js (see that file's own header comment
// for why IT avoids real sockets): this test is neither timing-sensitive nor
// concurrent -- one request per assertion -- so a real HTTP round trip is
// safe here, and it is the only way to actually prove body-parser's `limit`
// option plus the new 413-passthrough middleware in src/app.js work
// end-to-end; driving the route handler function directly (as the sibling
// file does) would bypass both and prove nothing about this change.
'use strict';

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const request = require('supertest');

const { loadApp, seed, signInGuest } = require('./helpers/testApp');

const ADMIN_PASSWORD = 'CorrectHorse!553';
// 17 KiB: one KiB over the 16kb (16 * 1024 byte) limit -- large enough that
// crossing the boundary is unambiguous, small enough the test stays fast.
const OVERSIZED_PASSWORD = 'a'.repeat(17 * 1024);

let app;
let db;
let authRouter;

beforeAll(() => {
  ({ app, db } = loadApp());

  // A real admin.hash must exist for the route's readFileSync guard to pass
  // (src/routes/auth.js) -- its contents are irrelevant to AC2/AC3 since
  // compareImpl is swapped out in those tests and never reads it, but AC4
  // never touches this route at all.
  const config = require('../config');
  fs.mkdirSync(path.dirname(config.ADMIN_HASH_PATH), { recursive: true });
  fs.writeFileSync(config.ADMIN_HASH_PATH, bcrypt.hashSync(ADMIN_PASSWORD, 4), 'utf8');

  authRouter = require('../src/routes/auth');
});

afterEach(() => {
  // Restore the real bcrypt.compare between tests so a spy set by one test
  // never leaks into the next (same pattern as
  // tests/admin-login-cpu-bound.test.js).
  authRouter._setCompareImplForTest(null);
});

describe('POST /admin/login body cap (#553)', () => {
  it('AC2: an oversized urlencoded password body is refused 413 before bcrypt runs, and a normal-size wrong password still reaches bcrypt (positive control)', async () => {
    let compareCalls = 0;
    authRouter._setCompareImplForTest(() => {
      compareCalls += 1;
      return Promise.resolve(false);
    });

    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send('password=' + OVERSIZED_PASSWORD);

    expect(res.status).toBe(413);
    // The load-bearing assertion: the compare spy was never invoked for the
    // oversized request -- body-parser refused it before the route handler
    // (and therefore the bcrypt gate) ever ran.
    expect(compareCalls).toBe(0);

    // Positive control, so the assertion above is not vacuous (e.g. a broken
    // wiring that never calls compareImpl at all would otherwise also read
    // as "0 calls" and falsely look like a pass). A normal-size wrong
    // password is NOT refused by the cap and DOES reach bcrypt.
    const controlRes = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'wrong-password' });

    expect(controlRes.status).toBe(401);
    expect(compareCalls).toBe(1);
  });

  it('AC3: the same oversized body is refused 413 over the JSON path too -- the same bound, not a bypass', async () => {
    let compareCalls = 0;
    authRouter._setCompareImplForTest(() => {
      compareCalls += 1;
      return Promise.resolve(false);
    });

    const res = await request(app)
      .post('/admin/login')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ password: OVERSIZED_PASSWORD }));

    expect(res.status).toBe(413);
    expect(compareCalls).toBe(0);
  });

  it('AC4: a 1000-character bug-report body (the largest real text field in src/views/) still succeeds, not 413', async () => {
    const { guestId } = seed(db);
    const agent = signInGuest(app, 'seedtoken');

    const longBody = 'x'.repeat(1000);
    const res = await agent.post('/bug-report').type('form').send({ body: longBody });

    // Not refused by the cap -- 16kb leaves an order of magnitude of
    // headroom over this 1000-character field.
    expect(res.status).not.toBe(413);
    // POST /bug-report redirects to '/' on a successful insert
    // (src/routes/guest.js).
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const row = db.prepare('SELECT body FROM bug_reports WHERE guest_id = ?').get(guestId);
    expect(row.body).toBe(longBody);
  });
});
