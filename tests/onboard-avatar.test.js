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
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

// Issue #929 AC2/AC4 (below): AVATAR_CONCURRENCY pinned to 1 and
// AVATAR_SLOT_WAIT_MS pinned to a few seconds -- set BEFORE loadApp() (which
// requires config) so config.AVATAR_CONCURRENCY/AVATAR_SLOT_WAIT_MS pick
// these up. Lets a test hold the avatar gate's only slot itself and
// deterministically drive a "briefly queued, then released in time" case
// (AC2) and a "queue already at the cap" case (AC4). Pinning
// AVATAR_CONCURRENCY=1 does not change this file's EXISTING #187 AC1/AC2
// tests below -- nothing else in this file holds the avatar slot, so those
// corrupt/non-image uploads still acquire it immediately, run (and fail
// inside sharp, or never reach sharp), and release, exactly as before.
//
// Saved before the module-scope overwrite (matching
// tests/upload-concurrency.test.js's restoreEnvVar discipline) and restored
// in afterAll, so this file never leaves a pinned value behind for whichever
// test file the runner loads next in the same process.
const SAVED_AVATAR_CONCURRENCY = process.env.AVATAR_CONCURRENCY;
const SAVED_AVATAR_SLOT_WAIT_MS = process.env.AVATAR_SLOT_WAIT_MS;
process.env.AVATAR_CONCURRENCY = '1';
process.env.AVATAR_SLOT_WAIT_MS = '3000';

let app;
let db;
let config;
let avatarSemaphore;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR.
  config = require('../config');
  ({ avatarSemaphore } = require('../src/utils/upload-concurrency'));
});

afterAll(() => {
  if (SAVED_AVATAR_CONCURRENCY === undefined) {
    delete process.env.AVATAR_CONCURRENCY;
  } else {
    process.env.AVATAR_CONCURRENCY = SAVED_AVATAR_CONCURRENCY;
  }
  if (SAVED_AVATAR_SLOT_WAIT_MS === undefined) {
    delete process.env.AVATAR_SLOT_WAIT_MS;
  } else {
    process.env.AVATAR_SLOT_WAIT_MS = SAVED_AVATAR_SLOT_WAIT_MS;
  }
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

// ---------------------------------------------------------------------------
// Issue #929 — avatar processing has no concurrency bound. AC2 and AC4 are
// both join-flow cases: a guest's avatar queues briefly behind the (test-
// pinned AVATAR_CONCURRENCY=1) gate held by another save. AC2's queue clears
// in time and the avatar is saved; AC4's queue is already full and the save
// fails fast -- either way POST /join itself must succeed (this file's #187
// header already established that a rejected/failed avatar is never a
// signup error).
// ---------------------------------------------------------------------------

describe('Issue #929 AC2: a briefly-held avatar gate does not block signup -- a short wait is invisible', () => {
  it('join succeeds after queuing for the gate, and the avatar is saved once it frees', async () => {
    const makeJpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 50, g: 140, b: 90 } },
    })
      .jpeg()
      .toBuffer();

    // Hold the only avatar slot ourselves (AVATAR_CONCURRENCY=1, pinned
    // above) before the request ever reaches photos.saveAvatar.
    await avatarSemaphore.acquire();

    let released = false;
    const releaseTimer = setTimeout(() => {
      released = true;
      avatarSemaphore.release();
    }, 150); // well inside the 3000ms AVATAR_SLOT_WAIT_MS pinned above

    try {
      const agent = request.agent(app);
      const res = await agent
        .post('/join')
        .field('name', 'Gate Wait Guest')
        .field('contact', 'gate-wait-ac2-929@example.com')
        .field('pin', '1111')
        .attach('avatar', makeJpeg, { filename: 'me.jpg', contentType: 'image/jpeg' });

      // The timed release must have already fired by the time the request
      // resolves -- otherwise this proves nothing about "a short wait is
      // invisible" (it would just mean the slot was never actually contended).
      expect(released).toBe(true);

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/how-to-play');

      const row = db
        .prepare('SELECT avatar_path FROM guests WHERE contact = ?')
        .get('gate-wait-ac2-929@example.com');
      expect(row).toBeTruthy();
      expect(row.avatar_path).toMatch(/\.jpg$/);
    } finally {
      clearTimeout(releaseTimer);
      // Belt-and-braces: if an assertion above threw before the timer fired,
      // make sure the slot we manually acquired is not leaked into later
      // tests in this file.
      if (!released) {
        avatarSemaphore.release();
      }
    }
  });
});

describe('Issue #929 AC4: a full avatar wait queue fails fast, and the join still succeeds', () => {
  it('avatar save fails fast; join still succeeds with guests.avatar_path null', async () => {
    const makeJpeg = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 60, b: 60 } },
    })
      .jpeg()
      .toBuffer();

    // Hold the only avatar slot (AVATAR_CONCURRENCY=1) ourselves.
    await avatarSemaphore.acquire();

    // Fill the wait queue to config.MAX_PENDING_AVATAR_WAITERS with manual
    // waiters that stay queued until we drain them below -- this drives the
    // gate's queue.length to exactly the cap that makes withAvatarSlot's
    // depth check trip.
    const fillerAcquires = [];
    for (let i = 0; i < config.MAX_PENDING_AVATAR_WAITERS; i++) {
      fillerAcquires.push(avatarSemaphore.acquire());
    }
    // Give the queued fillers a turn to actually register before checking.
    await new Promise((resolve) => setImmediate(resolve));
    expect(avatarSemaphore.pending).toBe(config.MAX_PENDING_AVATAR_WAITERS);

    try {
      const agent = request.agent(app);
      const res = await agent
        .post('/join')
        .field('name', 'Busy Gate Guest')
        .field('contact', 'busy-gate-ac4-929@example.com')
        .field('pin', '2222')
        .attach('avatar', makeJpeg, { filename: 'me.jpg', contentType: 'image/jpeg' });

      // Signup itself is unaffected by the avatar gate being full (issue
      // #929's non-goals: a silent, deliberate skip, not a signup error).
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/how-to-play');

      // The guest is still signed in -- a full avatar gate must not cost the
      // signup its session cookie either.
      const cookies = [].concat(res.headers['set-cookie'] || []);
      expect(cookies.some((c) => c.startsWith('gsid='))).toBe(true);

      const row = db
        .prepare('SELECT name, avatar_path, onboarded FROM guests WHERE contact = ?')
        .get('busy-gate-ac4-929@example.com');
      expect(row).toBeTruthy();
      expect(row.avatar_path).toBeNull();
      expect(row.onboarded).toBe(0);

      // The queue was never touched by the rejected save -- it fails BEFORE
      // ever joining the queue.
      expect(avatarSemaphore.pending).toBe(config.MAX_PENDING_AVATAR_WAITERS);
    } finally {
      // Drain everything we queued so later tests in this file see a
      // resting gate (active 0, queue empty), regardless of whether an
      // assertion above threw.
      avatarSemaphore.release(); // hands our held slot to the first filler
      await Promise.all(fillerAcquires.map((p) => p.then(() => avatarSemaphore.release())));
    }

    expect(avatarSemaphore.active).toBe(0);
    expect(avatarSemaphore.pending).toBe(0);
  });
});
