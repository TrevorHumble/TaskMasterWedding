// tests/onboard-avatar.test.js
// Issue #187: a corrupt or non-image avatar during signup must never kill the
// process. POST /onboard used to await saveAvatar() with no try/catch;
// Express 4 does not catch async-handler rejections, so one undecodable file
// (bytes labelled image/jpeg that sharp cannot read) crashed the whole server
// for every guest.
//
// Issue #244 retired /onboard — signup and avatar intake both happen in one
// POST /join now (issue #240), and #240 made a deliberate product choice this
// file's original assertions no longer match: /join never blocks or
// re-renders on a bad avatar (routes/auth.js's comment: "A rejected avatar...
// is not itself a reason to block signup"). trySaveAvatar's try/catch just
// drops the bad file and lets signup succeed with no avatar — there is no 400
// re-render left to assert on. What issue #187 actually needs protected —
// corrupt bytes never crashing the process — still holds and is what these
// tests now check against /join.
//
// AC1: corrupt bytes with Content-Type image/jpeg -> signup still succeeds
//      (302 to /how-to-play, issue #564), the guest has no avatar_path, and
//      the server survives.
// AC2: a non-image type (application/pdf) gets the same silent-drop
//      treatment, writes nothing to UPLOADS_DIR, and the process stays alive.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// photos (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let config;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR.
  config = require('../config');
});

const CORRUPT_JPEG = Buffer.from('this is not a real jpeg');

describe('AC1: corrupt avatar bytes do not block signup or kill the process', () => {
  it('signup succeeds with no avatar_path, and the server survives', async () => {
    const agent = request.agent(app);
    const res = await agent
      .post('/join')
      .field('name', 'Crash Test Guest')
      .field('contact', 'crash-test-jpeg@example.com')
      .field('pin', '1234')
      .attach('avatar', CORRUPT_JPEG, { filename: 'fake.jpg', contentType: 'image/jpeg' });

    // Signup is not blocked by a bad avatar — straight to the rules card
    // (issue #564), not a 400 re-render.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/how-to-play');

    const row = db
      .prepare('SELECT name, avatar_path, onboarded FROM guests WHERE contact = ?')
      .get('crash-test-jpeg@example.com');
    expect(row).toBeTruthy();
    expect(row.name).toBe('Crash Test Guest');
    expect(row.avatar_path).toBeNull();
    // Issue #564: onboarded starts at the schema default (0) — GET
    // /how-to-play is the only thing that ever flips it, not signup itself.
    expect(row.onboarded).toBe(0);

    // The server answers the next request (same session) — the corrupt
    // decode never crashed it.
    const home = await agent.get('/');
    expect(home.status).toBe(200);
  });
});

describe('AC2: non-image types are silently dropped, nothing written to disk', () => {
  it('rejects application/pdf without writing a file and stays alive', async () => {
    const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

    const agent = request.agent(app);
    const res = await agent
      .post('/join')
      .field('name', 'PDF Guest')
      .field('contact', 'pdf-guest@example.com')
      .field('pin', '4321')
      .attach('avatar', Buffer.from('%PDF-1.4 not an image'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });

    // Straight to the rules card, same as any other fresh signup (issue
    // #564) — a rejected file type is not itself a signup error.
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/how-to-play');

    const row = db
      .prepare('SELECT name, avatar_path FROM guests WHERE contact = ?')
      .get('pdf-guest@example.com');
    expect(row).toBeTruthy();
    expect(row.avatar_path).toBeNull();

    // Nothing was written to UPLOADS_DIR.
    const uploadsAfter = fs.readdirSync(config.UPLOADS_DIR).sort();
    expect(uploadsAfter).toEqual(uploadsBefore);

    // The process is alive and the next guest can still sign up (same session).
    const home = await agent.get('/');
    expect(home.status).toBe(200);
  });
});
