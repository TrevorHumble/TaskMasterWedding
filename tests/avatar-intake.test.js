// tests/avatar-intake.test.js
// Issue #122: signup (POST /join) and profile-edit (POST /me/edit) used to
// save avatars through two different mechanisms — the old onboarding step via
// multer memoryStorage straight to a Buffer, profile-edit via multer
// diskStorage followed by fs.readFileSync + fs.unlinkSync to reconstruct one.
// Both routes now share one memory-storage middleware (photos.uploadAvatar,
// field "avatar"), so req.file.buffer is available directly on both paths.
//
// AC2: a signup avatar upload sets guests.avatar_path to a stored .jpg
// filename and that file exists on disk. (Issue #244 retired the separate
// /onboard step this AC used to exercise — #240 already folded avatar
// intake into POST /join, so this now signs up fresh instead of onboarding
// an existing session.)
// AC3: a profile-edit avatar replacement removes the previous avatar file
// from disk and points avatar_path at the new file.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// photos (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

// Issue #929 AC5: AVATAR_CONCURRENCY pinned to 1 and AVATAR_SLOT_WAIT_MS
// pinned small -- set BEFORE loadApp() (which requires config) so a test can
// hold the avatar gate's only slot itself and drive a real wait-timeout in
// well under a second, through the real POST /me/edit route. Pinning these
// does not change this file's EXISTING AC2/AC3 tests below -- nothing else
// in this file holds the avatar slot, so those uploads still acquire it
// immediately and release, exactly as before.
//
// Saved before the module-scope overwrite (matching
// tests/upload-concurrency.test.js's restoreEnvVar discipline) and restored
// in afterAll, so this file never leaves a pinned value behind for whichever
// test file the runner loads next in the same process.
const TEST_AVATAR_SLOT_WAIT_MS = 150;
const SAVED_AVATAR_CONCURRENCY = process.env.AVATAR_CONCURRENCY;
const SAVED_AVATAR_SLOT_WAIT_MS = process.env.AVATAR_SLOT_WAIT_MS;
process.env.AVATAR_CONCURRENCY = '1';
process.env.AVATAR_SLOT_WAIT_MS = String(TEST_AVATAR_SLOT_WAIT_MS);

let app;
let db;
let config;
let avatarSemaphore;

// Two distinct valid JPEGs (different pixel color) so their encoded bytes —
// and therefore their stored filenames — differ, which lets AC3 assert the
// avatar_path actually changed on replacement rather than coincidentally
// matching.
let jpegOne;
let jpegTwo;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR.
  config = require('../config');
  ({ avatarSemaphore } = require('../src/utils/upload-concurrency'));

  jpegOne = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 200, g: 30, b: 30 } },
  })
    .jpeg()
    .toBuffer();

  jpegTwo = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 30, g: 30, b: 200 } },
  })
    .jpeg()
    .toBuffer();
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

function avatarAbsPath(filename) {
  return path.join(config.UPLOADS_DIR, filename);
}

describe('AC2: signup avatar upload stores a real file and sets avatar_path', () => {
  it('sets guests.avatar_path to a stored .jpg filename that exists on disk', async () => {
    const agent = request.agent(app);

    const res = await agent
      .post('/join')
      .field('name', 'Join Avatar Guest')
      .field('contact', 'join-avatar-ac2@example.com')
      .field('pin', '1357')
      .attach('avatar', jpegOne, { filename: 'me.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);

    const row = db
      .prepare('SELECT avatar_path, onboarded FROM guests WHERE contact = ?')
      .get('join-avatar-ac2@example.com');
    // Issue #564: onboarded starts at the schema default (0) after signup —
    // only GET /how-to-play ever flips it.
    expect(row.onboarded).toBe(0);
    expect(row.avatar_path).toMatch(/\.jpg$/);
    expect(fs.existsSync(avatarAbsPath(row.avatar_path))).toBe(true);
  });
});

describe('AC3: profile-edit avatar replacement removes the old file and updates avatar_path', () => {
  it('deletes the previous avatar file and points avatar_path at the new one', async () => {
    // Seed a guest with an existing avatar via signup first.
    const agent = request.agent(app);

    const joinRes = await agent
      .post('/join')
      .field('name', 'Replace Avatar Guest')
      .field('contact', 'join-avatar-ac3@example.com')
      .field('pin', '2468')
      .attach('avatar', jpegOne, { filename: 'first.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(joinRes.status);

    const guest = db
      .prepare('SELECT id FROM guests WHERE contact = ?')
      .get('join-avatar-ac3@example.com');
    const before = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guest.id);
    const oldAvatarPath = before.avatar_path;
    expect(oldAvatarPath).toMatch(/\.jpg$/);
    const oldAbsPath = avatarAbsPath(oldAvatarPath);
    expect(fs.existsSync(oldAbsPath)).toBe(true);

    // Replace it via profile-edit with a different image.
    const editRes = await agent
      .post('/me/edit')
      .field('name', 'Replace Avatar Guest')
      .attach('avatar', jpegTwo, { filename: 'second.jpg', contentType: 'image/jpeg' });
    expect([301, 302, 303]).toContain(editRes.status);

    const after = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guest.id);
    const newAvatarPath = after.avatar_path;

    // The value actually changed to a new stored file, not a no-op.
    expect(newAvatarPath).toMatch(/\.jpg$/);
    expect(newAvatarPath).not.toBe(oldAvatarPath);

    // The new file exists; the old one was removed from disk.
    expect(fs.existsSync(avatarAbsPath(newAvatarPath))).toBe(true);
    expect(fs.existsSync(oldAbsPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Issue #929 AC5: a queued avatar save whose slot does not free within
// AVATAR_SLOT_WAIT_MS (pinned to TEST_AVATAR_SLOT_WAIT_MS above) fails with
// AVATAR_SLOT_TIMEOUT. Since the PR review fix, that failure is a null
// return from photos.saveAvatar (not a throw), and src/routes/guest.js's
// POST /me/edit no longer bails out early on it: the guest still sees the
// existing "could not save" flash, but a simultaneous name/PIN/social change
// in the SAME POST still persists -- only the avatar itself is skipped.
// ---------------------------------------------------------------------------
describe('Issue #929 AC5: a wait that outlives AVATAR_SLOT_WAIT_MS fails, but the rest of the save still persists', () => {
  it('POST /me/edit shows the unchanged "could not save that avatar" flash, persists a simultaneous name change, and the gate returns to rest', async () => {
    const token = `avatar-timeout-ac5-${crypto.randomUUID()}`;
    const guestId = db
      .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
      .run(token, 'Timeout Guest').lastInsertRowid;
    const agent = request.agent(app);
    signInGuest(app, token, agent);

    // Hold the only avatar slot (AVATAR_CONCURRENCY=1) for the whole test --
    // stands in for issue #929's "instrumented long crop": a slot that never
    // frees before AVATAR_SLOT_WAIT_MS expires.
    await avatarSemaphore.acquire();

    try {
      const activeBefore = avatarSemaphore.active;

      const editRes = await agent
        .post('/me/edit')
        // A DIFFERENT name than the seeded 'Timeout Guest' -- the only way to
        // prove this persisted is if the row actually changed, not
        // coincidentally matched the seed value.
        .field('name', 'Timeout Guest Renamed')
        .attach('avatar', jpegOne, { filename: 'timeout.jpg', contentType: 'image/jpeg' });

      expect([301, 302, 303]).toContain(editRes.status);
      expect(editRes.headers.location).toBe('/me/edit');

      // The existing failure flash (src/routes/guest.js's gate-rejection
      // branch around photos.saveAvatar) — unchanged copy, unchanged class.
      const page = await agent.get('/me/edit');
      expect(page.text).toContain('Sorry, we could not save that avatar. Please try again.');
      expect(page.text).toContain('flash-err');

      // The failed avatar left avatar_path unchanged (still null) -- but the
      // name change from the SAME POST persisted regardless (issue #929 PR
      // review fix: a gate rejection must not cost the guest the rest of
      // their form).
      const row = db.prepare('SELECT avatar_path, name FROM guests WHERE id = ?').get(guestId);
      expect(row.avatar_path).toBeNull();
      expect(row.name).toBe('Timeout Guest Renamed');

      // No slot leak: the timed-out waiter never held a slot, so `active`
      // is exactly what it was before it ever queued (still just our hold).
      expect(avatarSemaphore.active).toBe(activeBefore);
      expect(avatarSemaphore.pending).toBe(0);
    } finally {
      avatarSemaphore.release();
    }

    // Back to a fully resting gate for any later test in this file.
    expect(avatarSemaphore.active).toBe(0);
    expect(avatarSemaphore.pending).toBe(0);
  });
});
