// tests/guest-delete-avatar.test.js
// Covers issue #196 acceptance criteria AC1-AC3: deleting a guest via
// POST /admin/guests/:id/delete must also remove their avatar file from disk,
// must not break for guests without an avatar, and must not abort the delete
// if the avatar file is already missing from disk.
//
// REQUIRE ORDER: config / db are required only AFTER loadApp() sets DATA_DIR /
// DB_PATH env vars (same rule as other tests in this suite — see
// tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

// Realistic stored filename shape (matches photos.js's ORIGINAL_RE allowlist:
// ^[0-9a-f]{16}-\d+\.(jpg|png|webp)$) so the /uploads static-mount guard
// treats it like a real avatar rather than rejecting it on shape alone.
const AVATAR_NAME = 'd4e5f6071819202a-1719500000010.jpg';
const MISSING_AVATAR_NAME = 'e5f6071819202a3b-1719500000011.jpg';

// A 1x1 red pixel PNG — valid image bytes, tiny, no sharp dependency needed
// to produce it. Written straight to disk so express.static finds a real file.
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

/**
 * Sign in as a fresh guest via their private link and return an agent that
 * carries the resulting gsid cookie (same pattern as
 * tests/avatar-upload-limit.test.js). A request without ANY guest session
 * never reaches the static mount's plain 404 — session.requireGuest (mounted
 * at '/' by guest.js) intercepts it first and renders its own 403 "private
 * link needed" page. Signing in as a bystander guest lets the request fall
 * through to the app's real 404 handler when the avatar file is gone, which
 * is what AC1 means by "GET /uploads/<avatar filename> returns 404".
 */
async function makeGuestAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

let app;
let db;
let uploadsDir;
let adminAgent;
let bystanderAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;

  const config = require('../config');
  uploadsDir = config.UPLOADS_DIR;

  adminAgent = await makeAdminAgent(app);

  // A guest who is NOT the one being deleted, used only to carry a valid
  // gsid cookie so the post-delete /uploads request exercises the real
  // static-file-missing path instead of the anonymous-visitor 403 gate.
  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
    'bystandertoken',
    'Bystander Guest'
  );
  bystanderAgent = await makeGuestAgent('bystandertoken');
});

// ---------------------------------------------------------------------------
// AC1: Guest with a saved avatar — the file is removed from disk and the
// public URL 404s once the guest is deleted.
// ---------------------------------------------------------------------------
it('AC1: deleting a guest removes their avatar file and it 404s afterward', async () => {
  fs.writeFileSync(path.join(uploadsDir, AVATAR_NAME), TINY_PNG);

  const guestId = db
    .prepare('INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, ?)')
    .run('ac1token', 'Avatar Guest', AVATAR_NAME).lastInsertRowid;

  // Confirm the file is really there and served before the delete. This is
  // what gives the post-delete assertions their teeth: if the fix were
  // reverted (avatar left on disk), this pre-check would still pass, but the
  // post-delete existsSync/404 checks below would then FAIL — which is exactly
  // how this test catches the bug.
  expect(fs.existsSync(path.join(uploadsDir, AVATAR_NAME))).toBe(true);
  const before = await bystanderAgent.get('/uploads/' + AVATAR_NAME);
  expect(before.status).toBe(200);

  const res = await adminAgent
    .post('/admin/guests/' + guestId + '/delete')
    .type('form')
    .send({});
  expect(res.status).toBe(303);

  // The file itself is gone from disk.
  expect(fs.existsSync(path.join(uploadsDir, AVATAR_NAME))).toBe(false);

  // And it is no longer publicly servable. Use a signed-in guest (bystanderAgent)
  // so the request reaches the static mount's real "file not found" behavior
  // instead of being pre-empted by requireGuest's 403 for anonymous visitors.
  const after = await bystanderAgent.get('/uploads/' + AVATAR_NAME);
  expect(after.status).toBe(404);

  // The guest row itself is gone too.
  const row = db.prepare('SELECT id FROM guests WHERE id = ?').get(guestId);
  expect(row).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AC2: Guest with no avatar (avatar_path IS NULL) — delete behaves exactly
// like today: same redirect target and flash message, row removed.
// ---------------------------------------------------------------------------
it('AC2: deleting a guest with no avatar redirects and deletes normally', async () => {
  const guestId = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('ac2token', 'No Avatar Guest').lastInsertRowid;

  const res = await adminAgent
    .post('/admin/guests/' + guestId + '/delete')
    .type('form')
    .send({});

  expect(res.status).toBe(303);
  expect(res.headers.location).toBe('/admin/guests?msg=Guest%20and%20their%20photos%20deleted.');

  const row = db.prepare('SELECT id FROM guests WHERE id = ?').get(guestId);
  expect(row).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AC3: Guest whose avatar_path names a file already absent from disk — the
// missing file (ENOENT) does not abort the delete; the guest row is still
// removed.
// ---------------------------------------------------------------------------
it('AC3: a missing avatar file on disk does not abort the guest delete', async () => {
  // Deliberately do NOT write MISSING_AVATAR_NAME to disk.
  expect(fs.existsSync(path.join(uploadsDir, MISSING_AVATAR_NAME))).toBe(false);

  const guestId = db
    .prepare('INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, ?)')
    .run('ac3token', 'Missing Avatar Guest', MISSING_AVATAR_NAME).lastInsertRowid;

  const res = await adminAgent
    .post('/admin/guests/' + guestId + '/delete')
    .type('form')
    .send({});

  expect(res.status).toBe(303);
  expect(res.headers.location).toBe('/admin/guests?msg=Guest%20and%20their%20photos%20deleted.');

  const row = db.prepare('SELECT id FROM guests WHERE id = ?').get(guestId);
  expect(row).toBeUndefined();
});
