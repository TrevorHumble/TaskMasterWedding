// tests/takedown-guard-admin.test.js
// Issue #191: an authenticated admin must see taken-down photos (thumb +
// original) so the moderation page can render something other than a broken
// image when deciding whether to restore. Guests (and anonymous requests)
// must keep getting the issue #34 404, and live (not-taken-down) photos must
// be unaffected either way.
//
// REQUIRE ORDER: same rule as tests/photo-access.test.js — config/db/services
// are required only after loadApp() sets DATA_DIR/DB_PATH.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

// Realistic stored filenames (must match the allowlist regexes in photos.js).
const PHOTO_NAME = 'd4e5f6071819a1b2-1719500000010.jpg';
const THUMB_NAME = 'd4e5f6071819a1b2-1719500000010.jpg.jpg';
const LIVE_PHOTO_NAME = 'e5f6071819a1b2c3-1719500000011.jpg';
const LIVE_THUMB_NAME = 'e5f6071819a1b2c3-1719500000011.jpg.jpg';

// A 1x1 red pixel PNG — valid image bytes so express.static has a real file
// to serve (matches the fixture already used in tests/photo-access.test.js).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

let app;
let db;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;

  const config = require('../config');
  const uploadsDir = config.UPLOADS_DIR;
  const thumbsDir = config.THUMBS_DIR;

  fs.writeFileSync(path.join(uploadsDir, PHOTO_NAME), TINY_PNG);
  fs.writeFileSync(path.join(thumbsDir, THUMB_NAME), TINY_PNG);
  fs.writeFileSync(path.join(uploadsDir, LIVE_PHOTO_NAME), TINY_PNG);
  fs.writeFileSync(path.join(thumbsDir, LIVE_THUMB_NAME), TINY_PNG);

  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Takedown Admin Test Task').lastInsertRowid;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('takedowntoken', 'Takedown Guest').lastInsertRowid;

  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 1)`
  ).run(guestId, taskId, PHOTO_NAME, THUMB_NAME);

  // A separate, onboarded guest with a contact + PIN so AC2 can sign in with
  // a real, signed gsid cookie (not an admin cookie) rather than asserting
  // against a cookie we merely assume exists.
  db.prepare(
    `INSERT INTO guests (token, name, onboarded, contact, contact_type, pin)
     VALUES (?, ?, 1, ?, ?, ?)`
  ).run('takedown-guest-login', 'Takedown Login Guest', 'guest191@example.com', 'email', '4242');

  const taskId2 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Takedown Admin Test Live Task').lastInsertRowid;
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  ).run(guestId, taskId2, LIVE_PHOTO_NAME, LIVE_THUMB_NAME);
});

// ---------------------------------------------------------------------------
// AC1: admin session sees both the taken-down thumb and original (200).
// ---------------------------------------------------------------------------
describe('AC1: admin bypass on taken-down files', () => {
  it('admin → taken-down original 200', async () => {
    const admin = await makeAdminAgent(app);
    const res = await admin.get('/uploads/' + PHOTO_NAME);
    expect(res.status).toBe(200);
  });

  it('admin → taken-down thumb 200', async () => {
    const admin = await makeAdminAgent(app);
    const res = await admin.get('/thumbs/' + THUMB_NAME);
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// AC2: guest-cookie-only and no-cookie requests are still blocked (404) —
// the #34 protection is unchanged for non-admins.
// ---------------------------------------------------------------------------
describe('AC2: non-admin requests remain blocked', () => {
  // Sign in as a real guest (POST /login) so the agent carries a genuine
  // signed `gsid` cookie — the exact "valid guest cookie" case AC2 names —
  // with no admin cookie present.
  async function guestAgent() {
    const agent = request.agent(app);
    const res = await agent
      .post('/login')
      .type('form')
      .send({ contact: 'guest191@example.com', pin: '4242' });
    expect(res.status).toBe(302); // sanity: login actually succeeded
    return agent;
  }

  it('guest cookie only → taken-down original 404', async () => {
    const agent = await guestAgent();
    const res = await agent.get('/uploads/' + PHOTO_NAME);
    expect(res.status).toBe(404);
  });

  it('guest cookie only → taken-down thumb 404', async () => {
    const agent = await guestAgent();
    const res = await agent.get('/thumbs/' + THUMB_NAME);
    expect(res.status).toBe(404);
  });

  it('no cookie at all → taken-down original 404', async () => {
    const res = await request(app).get('/uploads/' + PHOTO_NAME);
    expect(res.status).toBe(404);
  });

  it('no cookie at all → taken-down thumb 404', async () => {
    const res = await request(app).get('/thumbs/' + THUMB_NAME);
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC3: live (not-taken-down) photos are served regardless of admin status —
// status quo, both for anonymous and admin requests.
// ---------------------------------------------------------------------------
describe('AC3: live photos unaffected', () => {
  it('no cookie → live original 200', async () => {
    const res = await request(app).get('/uploads/' + LIVE_PHOTO_NAME);
    expect(res.status).toBe(200);
  });

  it('no cookie → live thumb 200', async () => {
    const res = await request(app).get('/thumbs/' + LIVE_THUMB_NAME);
    expect(res.status).toBe(200);
  });

  it('admin → live original 200', async () => {
    const admin = await makeAdminAgent(app);
    const res = await admin.get('/uploads/' + LIVE_PHOTO_NAME);
    expect(res.status).toBe(200);
  });
});
