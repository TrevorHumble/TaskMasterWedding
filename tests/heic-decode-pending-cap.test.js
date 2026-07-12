// tests/heic-decode-pending-cap.test.js
// Issue #281 (round 8): a GLOBAL cap on the number of pending (queued +
// in-flight) HEIC decodes bounds total held-buffer memory. Each pending decode
// pins its ~15 MB source buffer until its turn; the per-guest rate limit bounds
// enqueue RATE but not queue DEPTH, so without this cap a flood of hang-crafted
// HEICs (draining slowly against the decode timeout) grows held memory without
// bound and OOMs the ~2 GB host. This suite proves:
//   1. once MAX_PENDING_HEIC_DECODES pending decodes are in flight, a further
//      HEIC upload is rejected with the HEIC_RATE_LIMITED copy WITHOUT being
//      decoded (fast rejection, no pinned buffer), and
//   2. after the in-flight decodes settle (here via timeout), the cap frees and
//      a new HEIC upload is admitted and converts;
//   3. a normal single HEIC (under the cap) still converts, and JPEG is never
//      affected.
// It would FAIL if the cap were removed (the over-cap upload would be admitted
// and queued behind the hung decodes instead of rejected).
//
// DETERMINISM: env set at module scope BEFORE loadApp() requires config/photos.
//   - MAX_PENDING_HEIC_DECODES = 2 (small cap).
//   - HEIC_WORKER_PATH -> the hanging worker seam, so a HANG_MARKER input hangs
//     (occupying a pending slot) and any other input decodes normally.
//   - HEIC_DECODE_TIMEOUT_MS short, so hung decodes settle quickly and free the
//     cap without waiting the production 20s.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');
const { craftHeicHeader, HANG_MARKER } = require('./helpers/heic-fixtures');

const TEST_PENDING_CAP = 2;
const TEST_TIMEOUT_MS = 1000;
process.env.MAX_PENDING_HEIC_DECODES = String(TEST_PENDING_CAP);
process.env.HEIC_DECODE_TIMEOUT_MS = String(TEST_TIMEOUT_MS);
process.env.HEIC_WORKER_PATH = path.join(__dirname, 'fixtures', 'hanging-heic-worker.js');

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
    create: { width: 8, height: 8, channels: 3, background: { r: 30, g: 120, b: 200 } },
  })
    .jpeg()
    .toBuffer();
});

function insertGuest(prefix) {
  const token = `${prefix}-${crypto.randomUUID()}`;
  const guestId = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Cap Guest').lastInsertRowid;
  return { guestId, token };
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

// A HEIC that passes looksLikeHeic + the pixel cap but makes the hanging worker
// hang forever, so it occupies a pending decode slot until the timeout fires.
function hangingHeicBuffer() {
  return Buffer.concat([craftHeicHeader(100, 100), Buffer.from(HANG_MARKER)]);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

describe('global pending HEIC-decode cap bounds held memory', () => {
  it('rejects over-cap HEIC uploads WITHOUT decoding, then frees the cap once in-flight decodes settle', async () => {
    // The cap is GLOBAL (across all guests). Use DISTINCT guests/agents for the
    // two fillers and the over-cap probe so they run on independent connections
    // (a single supertest agent serializes its requests on one socket) — which
    // is also the real threat: many self-onboarding guests flooding at once.
    const g1 = insertGuest('cap-1');
    const g2 = insertGuest('cap-2');
    const g3 = insertGuest('cap-3');
    const [a1, a2, a3] = await Promise.all([
      makeGuestAgent(g1.token),
      makeGuestAgent(g2.token),
      makeGuestAgent(g3.token),
    ]);

    // Fill the cap with TEST_PENDING_CAP hanging decodes (one in-flight, the
    // rest queued — both count as pending and pin their buffers). .then() SENDs
    // each request (superagent defers the send until .then/.end); do not await
    // completion — they stay pending (hung) until their decode timeout.
    const t1 = insertTask('hang 1');
    const t2 = insertTask('hang 2');
    const p1 = a1
      .post(`/tasks/${t1}/submit`)
      .attach('photo', hangingHeicBuffer(), { filename: 'h1.heic', contentType: 'image/heic' })
      .then(
        (r) => r,
        () => null
      );
    const p2 = a2
      .post(`/tasks/${t2}/submit`)
      .attach('photo', hangingHeicBuffer(), { filename: 'h2.heic', contentType: 'image/heic' })
      .then(
        (r) => r,
        () => null
      );

    // Let both reach the decode admission point (increment) — well under the
    // decode timeout, so both are still pending when the next upload arrives.
    await delay(400);

    // Over-cap upload (a third guest): rejected FAST (well before the decode
    // timeout) with the rate-limit copy, and no row — proof it was
    // cap-rejected, not decoded.
    const t3 = insertTask('over cap');
    const started = Date.now();
    const overRes = await a3
      .post(`/tasks/${t3}/submit`)
      .attach('photo', hangingHeicBuffer(), { filename: 'h3.heic', contentType: 'image/heic' });
    const elapsed = Date.now() - started;

    expect([301, 302, 303]).toContain(overRes.status);
    expect(overRes.headers.location).toBe(`/tasks/${t3}`);
    expect(elapsed).toBeLessThan(TEST_TIMEOUT_MS); // not decoded/hung — rejected immediately
    const overRow = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(g3.guestId, t3);
    expect(overRow).toBeUndefined(); // fails here if the cap is removed (would queue, not reject)

    const overPage = await a3.get(`/tasks/${t3}`);
    expect(overPage.text).toContain('faster than we can process them');

    // Let the two hung decodes settle (timeout), freeing the cap. They are
    // serialized, so they time out ~one after the other.
    await Promise.all([p1, p2]);

    // A new HEIC upload is now admitted and converts end-to-end — the cap
    // freed as the earlier decodes settled.
    const t4 = insertTask('after free');
    const okRes = await a3
      .post(`/tasks/${t4}/submit`)
      .attach('photo', realHeic, { filename: 'ok.heic', contentType: 'image/heic' });
    expect([301, 302, 303]).toContain(okRes.status);
    const okRow = db
      .prepare('SELECT photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(g3.guestId, t4);
    expect(okRow).toBeDefined();
    expect(okRow.photo_path).toMatch(/\.jpg$/);
    const thumb = await a3.get('/thumbs/' + okRow.thumb_path);
    expect(thumb.status).toBe(200);
  }, 20000);

  it('a normal single HEIC (under the cap) converts, and JPEG is never affected by the cap', async () => {
    const { guestId, token } = insertGuest('cap-normal');
    const agent = await makeGuestAgent(token);

    // Several JPEGs back-to-back — none are HEIC, so none touch the pending cap.
    for (let i = 0; i < TEST_PENDING_CAP + 2; i++) {
      const jt = insertTask('jpeg ' + i);
      const jr = await agent
        .post(`/tasks/${jt}/submit`)
        .attach('photo', realJpeg, { filename: `j${i}.jpg`, contentType: 'image/jpeg' });
      expect([301, 302, 303]).toContain(jr.status);
      const jrow = db
        .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
        .get(guestId, jt);
      expect(jrow).toBeDefined();
    }

    // A single normal HEIC converts (cap has room; decodes are sequential).
    const ht = insertTask('single heic');
    const hr = await agent
      .post(`/tasks/${ht}/submit`)
      .attach('photo', realHeic, { filename: 'single.heic', contentType: 'image/heic' });
    expect([301, 302, 303]).toContain(hr.status);
    const hrow = db
      .prepare('SELECT photo_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, ht);
    expect(hrow).toBeDefined();
    expect(hrow.photo_path).toMatch(/\.jpg$/);
  });
});
