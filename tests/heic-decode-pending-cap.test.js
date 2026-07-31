// tests/heic-decode-pending-cap.test.js
// Issue #281 (round 8), re-scoped by #930: a GLOBAL cap on the number of
// pending (queued + in-flight) HEIC decodes bounds total held decode memory.
// #930 replaced the admission mechanism (heicDecodeChain promise chain +
// pendingHeicDecodes counter) with heicDecodeSemaphore (src/utils/semaphore.js),
// admitted through src/utils/upload-concurrency.js's withBoundedSlot (the
// semaphore is capacity 1; the 12-deep ceiling lives in withBoundedSlot's
// occupancy check),
// and made a QUEUED decode cheap for DISK callers (task submit, memory
// batch): convertHeicToJpeg reads the full source buffer only after a decode
// slot is actually granted (the deferred-read supplier pattern), so a queued
// disk decode holds an open fd + a ~256 KB sniff prefix, with at most ONE
// full DISK-caller buffer pinned (the single active decode). Memory-resident callers
// (avatar, multer memoryStorage) pin their full buffer for the whole queued
// wait regardless — worst case MAX_PENDING_HEIC_DECODES x MAX_UPLOAD_BYTES,
// transient. The full caller-kind-aware arithmetic that licenses raising the
// ceiling 8 -> 12 lives in DESIGN.md's "Global pending-decode cap and
// admission" entry — that entry, not this header, is the cost model.
// This suite proves:
//   1. once MAX_PENDING_HEIC_DECODES pending decodes are in flight, a further
//      HEIC upload is rejected with the HEIC_RATE_LIMITED copy WITHOUT being
//      decoded (fast rejection, no pinned buffer) — unchanged in meaning;
//   2. after the in-flight decodes settle (here via decode timeout), the cap
//      frees and a new HEIC upload is admitted and converts — unchanged;
//   3. a normal single HEIC (under the cap) still converts, and JPEG is never
//      affected — unchanged;
//   4. (AC2) a multi-file memory batch whose middle HEIC is admitted one
//      below the ceiling still persists the WHOLE batch;
//   5. (AC3) a decode that is admitted (under the ceiling) but stuck QUEUED
//      behind a hung ACTIVE decode is rejected once HEIC_QUEUE_WAIT_MS
//      expires — a wait bound that did not exist before #930 (an admitted
//      decode would previously simply succeed late) — and no slot leaks from
//      that expiry (proven behaviorally via the exported heicDecodeSemaphore).
// It would FAIL if the cap were removed (the over-cap upload would be admitted
// and queued behind the hung decodes instead of rejected).
//
// DETERMINISM: env set at module scope BEFORE loadApp() requires config/photos.
//   - MAX_PENDING_HEIC_DECODES = 2 (small cap).
//   - HEIC_WORKER_PATH -> the hanging worker seam, so a HANG_MARKER input hangs
//     (occupying a pending slot) and any other input decodes normally.
//   - HEIC_DECODE_TIMEOUT_MS short, so hung decodes settle quickly and free the
//     cap without waiting the production 20s.
// HEIC_QUEUE_WAIT_MS is deliberately NOT pinned here at module scope (that
// would apply for the whole file and could race the over-cap probe test
// above, which relies on hung decodes settling via HEIC_DECODE_TIMEOUT_MS,
// not the wait bound). AC3 below instead mutates config.HEIC_QUEUE_WAIT_MS
// directly, per-test, with a restore in `finally` — the same pattern
// tests/rate-limit.test.js:202 uses for a per-test config value.
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
let config;
let photos;
let realHeic;
let realJpeg;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR
  // (REQUIRE ORDER — see tests/heic-conversion.test.js's identical comment).
  config = require('../config');
  photos = require('../src/services/photos');

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

  it('AC2: a memory batch whose middle HEIC is admitted one below the ceiling still persists the whole batch', async () => {
    // Occupy exactly TEST_PENDING_CAP - 1 pending slots with one hanging
    // decode (it becomes the single ACTIVE decode -- heicDecodeSemaphore has
    // capacity 1), leaving exactly one slot free: the "one below the
    // ceiling" admission state this AC's middle file must land in.
    const filler = insertGuest('cap-batch-filler');
    const fillerAgent = await makeGuestAgent(filler.token);
    const fillerTask = insertTask('batch filler hang');
    const fillerPromise = fillerAgent
      .post(`/tasks/${fillerTask}/submit`)
      .attach('photo', hangingHeicBuffer(), { filename: 'filler.heic', contentType: 'image/heic' })
      .then(
        (r) => r,
        () => null
      );
    // Let the filler reach admission (its decode becomes ACTIVE) before the
    // batch below arrives -- well under its own HEIC_DECODE_TIMEOUT_MS.
    await delay(200);

    const { guestId, token } = insertGuest('cap-batch');
    const agent = await makeGuestAgent(token);

    // 3-file batch: JPEG, HEIC, JPEG. The middle HEIC's convertHeicToJpeg
    // admission check runs while pending = 1 (TEST_PENDING_CAP - 1) -- one
    // below the ceiling -- so it is ADMITTED, then queues behind the filler's
    // active decode until the filler's decode times out and releases the
    // slot; it then decodes for real and the batch completes.
    const batchRes = await agent
      .post('/memories')
      .field('caption', 'batch at the edge of the ceiling')
      .attach('photos', realJpeg, { filename: 'b1.jpg', contentType: 'image/jpeg' })
      .attach('photos', realHeic, { filename: 'b2.heic', contentType: 'image/heic' })
      .attach('photos', realJpeg, { filename: 'b3.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(batchRes.status);
    expect(batchRes.headers.location).toBe('/gallery');

    // All 3 files persisted -- the batch was NOT killed by the middle file's
    // brush with the ceiling (this is the regression #930 reduces: the
    // batch-kill boundary moves from depth 8 to depth 12 with cheap queueing,
    // it is not eliminated -- but a file admitted below the ceiling must
    // still succeed and keep its batch whole).
    const rows = db
      .prepare('SELECT photo_path FROM submissions WHERE guest_id = ? AND task_id IS NULL')
      .all(guestId);
    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.photo_path).toMatch(/\.jpg$/);
    }

    // The success flash renders on the redirect target (the same assertion
    // tests/memories.test.js's AC1 makes) -- confirms the guest sees the
    // ordinary "shared" copy, not some degraded/partial-batch message, even
    // though the middle file brushed the pending-decode ceiling.
    const galleryPage = await agent.get('/gallery');
    expect(galleryPage.text).toContain('Shared! They&#39;re in the gallery.');

    await fillerPromise; // let the hung filler settle before the next test
  }, 20000);

  it('AC3: a decode admitted below the ceiling but stuck queued behind a hung ACTIVE decode is rejected once HEIC_QUEUE_WAIT_MS expires, and no slot leaks', async () => {
    // Per-test config mutation with restore in `finally` (tests/rate-limit.test.js:202
    // pattern) -- NOT a file-scope env pin, which would apply for the whole
    // file and could race the over-cap probe test above.
    const originalWaitMs = config.HEIC_QUEUE_WAIT_MS;
    const TEST_WAIT_MS = 300; // well under TEST_TIMEOUT_MS (1000) -- the wait
    // must expire BEFORE the filler's own decode-timeout settle, or this test
    // would just be exercising the decode timeout, not the wait bound.
    config.HEIC_QUEUE_WAIT_MS = TEST_WAIT_MS;

    try {
      // One hanging decode occupies the single ACTIVE slot (capacity 1),
      // leaving one pending slot free (TEST_PENDING_CAP - 1 = 1).
      const filler = insertGuest('cap-wait-filler');
      const fillerAgent = await makeGuestAgent(filler.token);
      const fillerTask = insertTask('wait filler hang');
      const fillerPromise = fillerAgent
        .post(`/tasks/${fillerTask}/submit`)
        .attach('photo', hangingHeicBuffer(), {
          filename: 'filler.heic',
          contentType: 'image/heic',
        })
        .then(
          (r) => r,
          () => null
        );
      await delay(200); // filler reaches admission and becomes ACTIVE

      // A second HEIC is ADMITTED (pending 1 < 2) but must QUEUE (the single
      // active slot is taken), so it waits on heicDecodeSemaphore.acquire().
      // The filler will not settle until ~1000ms (its own decode timeout);
      // TEST_WAIT_MS (300) expires first, so this one is rejected by the
      // WAIT BOUND, not the decode timeout.
      const queued = insertGuest('cap-wait-queued');
      const queuedAgent = await makeGuestAgent(queued.token);
      const queuedTask = insertTask('wait queued');

      // fd-discriminated fs.readFileSync spy (the same idiom
      // tests/heic-conversion.test.js's #930 AC4 uses): discriminate on a
      // NUMBER first argument (an fd -- the full-file read
      // convertHeicToJpeg's supplier performs) vs a STRING (a path,
      // unrelated), always delegating to the real implementation. Installed
      // only around this one request so it proves THIS file's fd is never
      // read, without also catching the filler's own earlier read.
      const realReadFileSync = fs.readFileSync;
      const fdReadCalls = [];
      const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(function (...args) {
        if (typeof args[0] === 'number') fdReadCalls.push(Date.now());
        return realReadFileSync.apply(fs, args);
      });

      const started = Date.now();
      let queuedRes;
      try {
        queuedRes = await queuedAgent
          .post(`/tasks/${queuedTask}/submit`)
          .attach('photo', hangingHeicBuffer(), {
            filename: 'queued.heic',
            contentType: 'image/heic',
          });
      } finally {
        spy.mockRestore();
      }
      const elapsed = Date.now() - started;

      // Rejected with the existing HEIC_RATE_LIMITED copy -- same guest-safe
      // outcome as the ceiling rejection, just from expiry instead of
      // admission. No row: the fd behind this queued wait was NEVER read
      // (convertHeicToJpeg's supplier only runs after acquire() resolves;
      // this acquire() rejected instead) -- proven behaviorally, not just by
      // absence of a row, via the spy above: zero fd-keyed reads happened in
      // this whole request/response window.
      expect(fdReadCalls.length).toBe(0);
      expect([301, 302, 303]).toContain(queuedRes.status);
      expect(queuedRes.headers.location).toBe(`/tasks/${queuedTask}`);
      const queuedRow = db
        .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
        .get(queued.guestId, queuedTask);
      expect(queuedRow).toBeUndefined();
      const queuedPage = await queuedAgent.get(`/tasks/${queuedTask}`);
      expect(queuedPage.text).toContain('faster than we can process them');

      // Bounded by the WAIT knob, not the (longer) decode timeout: it comes
      // back well before the filler's own ~1000ms settle time.
      expect(elapsed).toBeLessThan(TEST_TIMEOUT_MS);
      expect(elapsed).toBeGreaterThanOrEqual(TEST_WAIT_MS - 100);

      // Let the filler settle (decode timeout). By the time its HTTP
      // response comes back, convertHeicToJpeg's `finally` has already run
      // heicDecodeSemaphore.release() (the response only follows the
      // settled convert promise), so the semaphore is provably back to an
      // idle baseline here -- the earlier queued-wait expiry left no
      // residue on either counter.
      await fillerPromise;
      expect(photos.heicDecodeSemaphore.active).toBe(0);
      expect(photos.heicDecodeSemaphore.pending).toBe(0);

      // The behavioral form of "no slot leaked" from the earlier expiry:
      // exactly TEST_PENDING_CAP (2) fresh admissions succeed...
      const fresh1 = insertGuest('cap-wait-fresh1');
      const fresh1Agent = await makeGuestAgent(fresh1.token);
      const fresh1Task = insertTask('wait fresh 1');
      const fresh1Promise = fresh1Agent
        .post(`/tasks/${fresh1Task}/submit`)
        .attach('photo', hangingHeicBuffer(), { filename: 'f1.heic', contentType: 'image/heic' })
        .then(
          (r) => r,
          () => null
        );
      await delay(100); // let fresh1 be admitted and go ACTIVE first

      const fresh2 = insertGuest('cap-wait-fresh2');
      const fresh2Agent = await makeGuestAgent(fresh2.token);
      const fresh2Task = insertTask('wait fresh 2');
      const fresh2Promise = fresh2Agent
        .post(`/tasks/${fresh2Task}/submit`)
        .attach('photo', hangingHeicBuffer(), { filename: 'f2.heic', contentType: 'image/heic' })
        .then(
          (r) => r,
          () => null
        );
      await delay(100); // fresh2 admitted (pending now = 2 = ceiling), queued

      // ...and the NEXT one (the 3rd) is refused fast -- if the earlier
      // wait-expiry had leaked a slot, pending would already read short of
      // 2 here and this 3rd arrival would be wrongly admitted instead.
      const over = insertGuest('cap-wait-over');
      const overAgent = await makeGuestAgent(over.token);
      const overTask = insertTask('wait over');
      const overStarted = Date.now();
      const overRes = await overAgent
        .post(`/tasks/${overTask}/submit`)
        .attach('photo', hangingHeicBuffer(), { filename: 'over.heic', contentType: 'image/heic' });
      const overElapsed = Date.now() - overStarted;

      expect([301, 302, 303]).toContain(overRes.status);
      expect(overElapsed).toBeLessThan(TEST_TIMEOUT_MS);
      const overRow = db
        .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
        .get(over.guestId, overTask);
      expect(overRow).toBeUndefined();

      // Let fresh1/fresh2's hangs settle so nothing leaks into later tests.
      await Promise.all([fresh1Promise, fresh2Promise]);
    } finally {
      config.HEIC_QUEUE_WAIT_MS = originalWaitMs;
    }
  }, 20000);
});
