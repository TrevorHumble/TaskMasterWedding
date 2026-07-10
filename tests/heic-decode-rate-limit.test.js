// tests/heic-decode-rate-limit.test.js
// Issue #281 (round 7): a per-guest HEIC-DECODE rate limit, checked BEFORE the
// decode, stops one hostile guest from flooding hang-crafted HEICs and
// monopolizing the single global, one-at-a-time decode chain (which would deny
// every guest's HEIC uploads — Goals A/D). The limit covers all three upload
// paths (task submit, memory batch, avatar) and NEVER throttles JPEG/PNG/WebP.
//
// DETERMINISM: HEIC_DECODE_RATE_MAX is pinned small (2) at module scope, BEFORE
// loadApp() requires config (same require-order rule as tests/memories.test.js).
// The window is left at its generous default so it never expires mid-test.
// Every test uses a fresh guest, and the limiter is keyed per guest, so the
// small cap never bleeds across tests.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

// Set BEFORE loadApp() requires config, so config.HEIC_DECODE_RATE_MAX picks it up.
const TEST_HEIC_DECODE_MAX = 2;
process.env.HEIC_DECODE_RATE_MAX = String(TEST_HEIC_DECODE_MAX);

let app;
let db;
let realHeic;
let realJpeg;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  realHeic = fs.readFileSync(path.join(__dirname, '../fixtures/sample-photos/sample-heic-01.heic'));
  realJpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 180, b: 90 } },
  })
    .jpeg()
    .toBuffer();
});

function insertGuest(prefix) {
  const token = `${prefix}-${crypto.randomUUID()}`;
  const guestId = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Flood Guest').lastInsertRowid;
  return { guestId, token };
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  await agent.get('/j/' + token).redirects(1);
  return agent;
}

describe('per-guest HEIC-decode rate limit', () => {
  it('rejects HEIC uploads once over the per-guest limit, WITHOUT decoding the over-limit one', async () => {
    const { guestId, token } = insertGuest('heic-rl');
    const agent = await makeGuestAgent(token);

    // The first TEST_HEIC_DECODE_MAX HEIC decodes are allowed and convert.
    for (let i = 0; i < TEST_HEIC_DECODE_MAX; i++) {
      const taskId = insertTask('Allowed task ' + i);
      const res = await agent
        .post(`/tasks/${taskId}/submit`)
        .attach('photo', realHeic, { filename: `ok-${i}.heic`, contentType: 'image/heic' });
      expect([301, 302, 303]).toContain(res.status);
      const row = db
        .prepare('SELECT photo_path FROM submissions WHERE guest_id = ? AND task_id = ?')
        .get(guestId, taskId);
      expect(row).toBeDefined(); // converted + stored
      expect(row.photo_path).toMatch(/\.jpg$/);
    }

    // The NEXT HEIC decode is over the limit -> rejected, no row.
    const overTaskId = insertTask('Over-limit task');
    const overRes = await agent
      .post(`/tasks/${overTaskId}/submit`)
      .attach('photo', realHeic, { filename: 'over.heic', contentType: 'image/heic' });
    expect([301, 302, 303]).toContain(overRes.status);
    expect(overRes.headers.location).toBe(`/tasks/${overTaskId}`);

    const overRow = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, overTaskId);
    expect(overRow).toBeUndefined(); // NOT stored — this fails if the check is removed

    // The flash carries the rate-limit copy, which is produced ONLY by the
    // pre-decode check (not by any decode-failure path) — proof the over-limit
    // upload was rejected WITHOUT being decoded.
    const page = await agent.get(`/tasks/${overTaskId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('faster than we can process them');
  });

  it('never throttles NON-HEIC uploads: real JPEGs succeed well past the HEIC limit', async () => {
    const { guestId, token } = insertGuest('jpeg-nolimit');
    const agent = await makeGuestAgent(token);

    // Upload 2x the HEIC cap worth of JPEGs; none touch the HEIC-decode budget.
    const count = TEST_HEIC_DECODE_MAX * 2 + 1;
    for (let i = 0; i < count; i++) {
      const taskId = insertTask('JPEG task ' + i);
      const res = await agent
        .post(`/tasks/${taskId}/submit`)
        .attach('photo', realJpeg, { filename: `j-${i}.jpg`, contentType: 'image/jpeg' });
      expect([301, 302, 303]).toContain(res.status);
      const row = db
        .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
        .get(guestId, taskId);
      expect(row).toBeDefined(); // every JPEG stored — never rate-limited
    }
  });

  it('a normal HEIC upload under the limit still converts end-to-end', async () => {
    const { guestId, token } = insertGuest('heic-normal');
    const agent = await makeGuestAgent(token);
    const taskId = insertTask('Normal HEIC task');

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', realHeic, { filename: 'normal.heic', contentType: 'image/heic' });
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
