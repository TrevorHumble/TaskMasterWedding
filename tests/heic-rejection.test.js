// tests/heic-rejection.test.js
// Issue #188: the pipeline used to accept image/heic and image/heif at intake even
// though the prebuilt sharp binaries cannot decode HEVC HEIC
// (sharp.format.heif.input.fileSuffix === ['.avif']) — the original was stored,
// makeThumb() threw, and the guest got a dead-end "Please try again" message
// for a submission that could never succeed. HEIC is now rejected at the
// fileFilter with actionable copy.
//
// AC1: image/heic POST /tasks/:id/submit -> no submissions row, no file left
//      in UPLOADS_DIR, redirect back to the task page with a flash containing
//      "photo format".
// AC2: the flash contains the literal word "screenshot" or the literal phrase
//      "Most Compatible".
// AC4: a valid JPEG still works end-to-end (row created, thumb serves 200).
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// photos (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let config;
let realJpeg;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR.
  config = require('../config');

  realJpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 180, b: 90 } },
  })
    .jpeg()
    .toBuffer();
});

function insertGuestAndTask() {
  const token = `heic-rejection-${crypto.randomUUID()}`;
  const guestId = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'HEIC Guest').lastInsertRowid;
  const taskId = db
    .prepare('INSERT INTO tasks (title) VALUES (?)')
    .run('Photo with the disco ball').lastInsertRowid;
  return { guestId, taskId, token };
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  await agent.get('/j/' + token).redirects(1);
  return agent;
}

// The fake bytes never reach sharp on the rejection path — the fileFilter
// rejects on the declared mimetype before storage runs.
const FAKE_HEIC = Buffer.from('not really heic bytes');

describe('AC1 + AC2: HEIC is rejected at intake with actionable copy', () => {
  for (const mimetype of ['image/heic', 'image/heif']) {
    it(`rejects ${mimetype}: no row, no orphan file, actionable flash`, async () => {
      const { guestId, taskId, token } = insertGuestAndTask();
      const agent = await makeGuestAgent(token);

      const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

      const res = await agent
        .post(`/tasks/${taskId}/submit`)
        .attach('photo', FAKE_HEIC, { filename: 'IMG_0001.HEIC', contentType: mimetype });

      // Redirects back to the task page (flash carries the message).
      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toBe(`/tasks/${taskId}`);

      // AC1: no submissions row, no file left behind.
      const row = db
        .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
        .get(guestId, taskId);
      expect(row).toBeUndefined();
      expect(fs.readdirSync(config.UPLOADS_DIR).sort()).toEqual(uploadsBefore);

      // Follow the redirect: the flash renders on the task page.
      const page = await agent.get(`/tasks/${taskId}`);
      expect(page.status).toBe(200);
      // AC1: the copy names the problem…
      expect(page.text).toContain('photo format');
      // AC2: …and a concrete remedy.
      expect(page.text).toContain('screenshot');
      expect(page.text).toContain('Most Compatible');
    });
  }
});

describe('AC4: JPEG uploads still work end-to-end', () => {
  it('creates a submissions row and serves the thumbnail', async () => {
    const { guestId, taskId, token } = insertGuestAndTask();
    const agent = await makeGuestAgent(token);

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', realJpeg, { filename: 'real.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);

    const row = db
      .prepare('SELECT photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeDefined();
    expect(row.photo_path).toMatch(/\.jpg$/);

    const thumb = await agent.get('/thumbs/' + row.thumb_path);
    expect(thumb.status).toBe(200);
  });
});
