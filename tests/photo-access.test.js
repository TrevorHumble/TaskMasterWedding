// tests/photo-access.test.js
// Covers issue #34 acceptance criteria AC1–AC6 (including AC2b, AC2c, AC2d, AC2e).
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH env vars. Node module cache means modules loaded before
// that point would silently read the wrong paths.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

// ---------------------------------------------------------------------------
// Realistic stored filenames (must match allowlist regex).
// Original:  ^[0-9a-f]{16}-\d+\.(jpg|png|webp|heic)$
// Thumb:     ^[0-9a-f]{16}-\d+\.(jpg|png|webp|heic)\.jpg$
// ---------------------------------------------------------------------------
const PHOTO_NAME = 'a1b2c3d4e5f60718-1719500000000.jpg';
const THUMB_NAME = 'a1b2c3d4e5f60718-1719500000000.jpg.jpg';
const LIVE_PHOTO_NAME = 'b2c3d4e5f6071819-1719500000001.jpg';
const LIVE_THUMB_NAME = 'b2c3d4e5f6071819-1719500000001.jpg.jpg';
const AVATAR_NAME = 'c3d4e5f607181920-1719500000002.jpg';

// A 1×1 red pixel in PNG — valid image bytes, tiny, no sharp dependency at
// generation time for the test matrix.  We write this to disk so express.static
// finds a real file (an empty placeholder would still 200 for the static serve).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let app;
let db;
let uploadsDir;
let thumbsDir;
let submissionId;
let liveSubmissionId;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;

  // config is now safely cached with the temp DATA_DIR.
  const config = require('../config');
  uploadsDir = config.UPLOADS_DIR;
  thumbsDir = config.THUMBS_DIR;

  // --- Write real image files to disk ------------------------------------------
  // taken-down submission files
  fs.writeFileSync(path.join(uploadsDir, PHOTO_NAME), TINY_PNG);
  fs.writeFileSync(path.join(thumbsDir, THUMB_NAME), TINY_PNG);

  // live submission files
  fs.writeFileSync(path.join(uploadsDir, LIVE_PHOTO_NAME), TINY_PNG);
  fs.writeFileSync(path.join(thumbsDir, LIVE_THUMB_NAME), TINY_PNG);

  // avatar file (no submission row — it is a guest avatar)
  fs.writeFileSync(path.join(uploadsDir, AVATAR_NAME), TINY_PNG);

  // --- Seed DB rows ------------------------------------------------------------
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Photo Access Test Task').lastInsertRowid;

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('phototoken', 'Photo Guest').lastInsertRowid;

  const avatarGuestId = db
    .prepare(`INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, ?)`)
    .run('avatartoken', 'Avatar Guest', AVATAR_NAME).lastInsertRowid;

  // Taken-down submission
  submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 1)`
    )
    .run(guestId, taskId, PHOTO_NAME, THUMB_NAME).lastInsertRowid;

  // Live (not taken-down) submission — uses a second task slot
  const taskId2 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Photo Access Live Task').lastInsertRowid;

  liveSubmissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(avatarGuestId, taskId2, LIVE_PHOTO_NAME, LIVE_THUMB_NAME).lastInsertRowid;
});

// ---------------------------------------------------------------------------
// AC1: Taken-down original is blocked.
// ---------------------------------------------------------------------------
it('AC1: taken-down original → 404', async () => {
  const res = await request(app).get('/uploads/' + PHOTO_NAME);
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AC2: Taken-down thumbnail is blocked.
// ---------------------------------------------------------------------------
it('AC2: taken-down thumbnail → 404', async () => {
  const res = await request(app).get('/thumbs/' + THUMB_NAME);
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AC2b: Case-variant of taken-down original is blocked.
// ---------------------------------------------------------------------------
it('AC2b: upper-cased taken-down original → 404', async () => {
  const upper = PHOTO_NAME.toUpperCase();
  const res = await request(app).get('/uploads/' + upper);
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AC2c: Case-variant of taken-down thumbnail is blocked.
// ---------------------------------------------------------------------------
it('AC2c: upper-cased taken-down thumbnail → 404', async () => {
  const upper = THUMB_NAME.toUpperCase();
  const res = await request(app).get('/thumbs/' + upper);
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AC2d: NTFS alternate-data-stream syntax is blocked.
// ---------------------------------------------------------------------------
it('AC2d: ::$DATA suffix on taken-down original → 404', async () => {
  const res = await request(app).get('/uploads/' + PHOTO_NAME + '::$DATA');
  expect(res.status).toBe(404);
});

it('AC2d: ::$DATA suffix on taken-down thumbnail → 404', async () => {
  const res = await request(app).get('/thumbs/' + THUMB_NAME + '::$DATA');
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AC2e: Malformed percent-escape is a clean 404, not a 500.
// ---------------------------------------------------------------------------
it('AC2e: malformed %ZZ in uploads path → 404 not 500', async () => {
  const res = await request(app).get('/uploads/%ZZ');
  expect(res.status).toBe(404);
});

it('AC2e: malformed %ZZ in thumbs path → 404 not 500', async () => {
  const res = await request(app).get('/thumbs/%ZZ');
  expect(res.status).toBe(404);
});

// ---------------------------------------------------------------------------
// AC3: Live photo still served.
// ---------------------------------------------------------------------------
it('AC3: live original → 200', async () => {
  const res = await request(app).get('/uploads/' + LIVE_PHOTO_NAME);
  expect(res.status).toBe(200);
});

it('AC3: live thumbnail → 200', async () => {
  const res = await request(app).get('/thumbs/' + LIVE_THUMB_NAME);
  expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// AC4: Avatar still served (avatar_path is not a submission photo_path).
// ---------------------------------------------------------------------------
it('AC4: avatar → 200', async () => {
  const res = await request(app).get('/uploads/' + AVATAR_NAME);
  expect(res.status).toBe(200);
});

// ---------------------------------------------------------------------------
// AC5: Restore re-enables serving.
// ---------------------------------------------------------------------------
it('AC5: restore → taken-down original now 200', async () => {
  // Confirm it's currently blocked.
  const before = await request(app).get('/uploads/' + PHOTO_NAME);
  expect(before.status).toBe(404);

  // Restore via the service (require after loadApp is safe).
  const photos = require('../src/services/photos');
  photos.restoreSubmission(submissionId);

  const after = await request(app).get('/uploads/' + PHOTO_NAME);
  expect(after.status).toBe(200);

  // Take it back down so subsequent AC1 re-runs would still pass (test isolation).
  photos.hideSubmission(submissionId);
});

// ---------------------------------------------------------------------------
// AC6: File preserved on takedown (takedown does not delete the file).
// ---------------------------------------------------------------------------
it('AC6: file still on disk after hideSubmission', async () => {
  const photos = require('../src/services/photos');
  photos.hideSubmission(liveSubmissionId);

  const stillExists = fs.existsSync(path.join(uploadsDir, LIVE_PHOTO_NAME));
  expect(stillExists).toBe(true);

  // Restore so AC3 live-serve tests are not affected by ordering.
  photos.restoreSubmission(liveSubmissionId);
});
