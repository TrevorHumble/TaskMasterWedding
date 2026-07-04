// tests/task-deletion.test.js
// Covers issue #39 acceptance criteria AC1–AC4.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH env vars. Node module cache means modules loaded before
// that point would silently read the wrong paths.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

// ---------------------------------------------------------------------------
// Realistic stored filenames (must match allowlist regex in photos service).
// Original:  ^[0-9a-f]{16}-\d+\.(jpg|png|webp)$
// Thumb:     ^[0-9a-f]{16}-\d+\.(jpg|png|webp)\.jpg$
// ---------------------------------------------------------------------------
const PHOTO_NAME = 'a1b2c3d4e5f60719-1719600000000.jpg';
const THUMB_NAME = 'a1b2c3d4e5f60719-1719600000000.jpg.jpg';

// A 1×1 red pixel in PNG — valid image bytes, tiny.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let app;
let db;
let adminAgent;
let uploadsDir;
let thumbsDir;
let taskId;
let submissionId;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;

  adminAgent = await makeAdminAgent(app);

  // config is now safely cached with the temp DATA_DIR.
  const config = require('../config');
  uploadsDir = config.UPLOADS_DIR;
  thumbsDir = config.THUMBS_DIR;

  // --- Write real image files to disk ------------------------------------------
  fs.writeFileSync(path.join(uploadsDir, PHOTO_NAME), TINY_PNG);
  fs.writeFileSync(path.join(thumbsDir, THUMB_NAME), TINY_PNG);

  // --- Seed DB rows ------------------------------------------------------------
  taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Task Deletion Test').lastInsertRowid;

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('deltoken', 'Del Guest').lastInsertRowid;

  submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, PHOTO_NAME, THUMB_NAME).lastInsertRowid;
});

// ---------------------------------------------------------------------------
// AC-1: task row, submission row, and both files are gone after delete.
// ---------------------------------------------------------------------------
it('AC-1: task delete removes task row, submission row, original and thumb', async () => {
  const originalPath = path.join(uploadsDir, PHOTO_NAME);
  const thumbPath = path.join(thumbsDir, THUMB_NAME);

  // Pre-condition: both files exist before the delete.
  expect(fs.existsSync(originalPath)).toBe(true);
  expect(fs.existsSync(thumbPath)).toBe(true);

  await adminAgent.post(`/admin/tasks/${taskId}/delete`);

  // Task row is gone.
  const taskRow = db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId);
  expect(taskRow).toBeUndefined();

  // Submission row is gone.
  const subRow = db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId);
  expect(subRow).toBeUndefined();

  // Original file is gone.
  expect(fs.existsSync(originalPath)).toBe(false);

  // Thumbnail is gone.
  expect(fs.existsSync(thumbPath)).toBe(false);
});

// ---------------------------------------------------------------------------
// AC-2: deleted task's photo is no longer served at its direct URL.
// Before the delete this URL served the image (200). After it, the file is
// gone from disk; express.static finds nothing and calls next(), so the
// request falls through to the guest router's requireGuest, which 403s an
// unauthenticated request. 403 is the precise proof the photo is not served.
// ---------------------------------------------------------------------------
it('AC-2: GET /uploads/<photo_path> after delete → 403 (file not served)', async () => {
  const res = await request(app).get('/uploads/' + PHOTO_NAME);
  expect(res.status).toBe(403);
});

// ---------------------------------------------------------------------------
// AC-3: deleting a task with NO submissions does not throw and returns 303.
// ---------------------------------------------------------------------------
it('AC-3: task with no submissions → 303, no error', async () => {
  const emptyTaskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Empty Task').lastInsertRowid;

  const res = await adminAgent.post(`/admin/tasks/${emptyTaskId}/delete`);
  expect(res.status).toBe(303);
});

// ---------------------------------------------------------------------------
// AC-4: delete redirects 303 to /admin/tasks (the "Task deleted." flash path).
// ---------------------------------------------------------------------------
it('AC-4: task delete redirect is 303 and location starts with /admin/tasks', async () => {
  const anotherTaskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Redirect Check Task').lastInsertRowid;

  const res = await adminAgent.post(`/admin/tasks/${anotherTaskId}/delete`);
  expect(res.status).toBe(303);
  expect(res.headers.location).toMatch(/^\/admin\/tasks/);
});
