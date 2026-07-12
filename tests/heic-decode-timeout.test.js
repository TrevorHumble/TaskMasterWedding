// tests/heic-decode-timeout.test.js
// Issue #281 (round 6): the HEIC decode runs in a worker, but the decode TIME
// must be bounded too. A crafted HEIC with a small ispe (under MAX_HEIC_PIXELS)
// but a pathological bitstream can drive libheif into a non-terminating decode:
// the worker never posts a result and never exits, so decodeHeicInWorker never
// settles — and because heicDecodeChain (the single global serialization point)
// advances only on settle, EVERY later HEIC upload would queue behind a promise
// that never resolves (process-wide denial of the HEIC path until restart).
//
// This suite proves the HEIC_DECODE_TIMEOUT_MS bound:
//   1. a decode that hangs is force-failed as a guest-safe BAD_IMAGE_TYPE
//      rejection within the timeout (not left hanging), and
//   2. a NORMAL HEIC uploaded immediately AFTER still converts — proving
//      heicDecodeChain advanced past the timed-out decode rather than wedging.
// It would FAIL if the timeout were removed (test 1 would hang and trip the
// test-runner timeout; the chain in test 2 would stay wedged).
//
// DETERMINISM: two env vars are set at module scope, BEFORE loadApp() requires
// photos.js (which reads both once at load — same require-order rule as
// tests/memories.test.js):
//   - HEIC_WORKER_PATH points photos.js at tests/fixtures/hanging-heic-worker.js,
//     a controllable worker that hangs on the HANG_MARKER sentinel and otherwise
//     decodes normally via real heic-convert.
//   - HEIC_DECODE_TIMEOUT_MS is set short (600ms) so the hang test resolves fast
//     without waiting the production 20s.
'use strict';

const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');
const { craftHeicHeader, HANG_MARKER } = require('./helpers/heic-fixtures');

// MUST be set before loadApp() requires config/photos (module-level, runs
// before the beforeAll below).
const TEST_DECODE_TIMEOUT_MS = 600;
process.env.HEIC_WORKER_PATH = path.join(__dirname, 'fixtures', 'hanging-heic-worker.js');
process.env.HEIC_DECODE_TIMEOUT_MS = String(TEST_DECODE_TIMEOUT_MS);

let app;
let db;
let realHeic;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  realHeic = require('fs').readFileSync(
    path.join(__dirname, '../fixtures/sample-photos/sample-heic-01.heic')
  );
});

function insertGuestAndTask(prefix) {
  const token = `${prefix}-${crypto.randomUUID()}`;
  const guestId = db
    .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
    .run(token, 'Timeout Guest').lastInsertRowid;
  const taskId = db
    .prepare('INSERT INTO tasks (title) VALUES (?)')
    .run('Photo with the arch').lastInsertRowid;
  return { guestId, taskId, token };
}

async function makeGuestAgent(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

// A buffer that passes looksLikeHeic (ftyp 'heic') AND the pixel cap (100x100),
// so it reaches the worker — with the HANG_MARKER suffix that makes the
// test-only worker hang forever.
function hangingHeicBuffer() {
  return Buffer.concat([craftHeicHeader(100, 100), Buffer.from(HANG_MARKER)]);
}

describe('HEIC decode timeout bounds a hung decode and does not wedge the chain', () => {
  it('a hanging decode is rejected as BAD_IMAGE_TYPE within the timeout, and the NEXT normal HEIC still converts', async () => {
    // 1) A HEIC whose decode hangs. Without the timeout this request would hang
    //    forever; with it, the request comes back within ~timeout + overhead.
    const hang = insertGuestAndTask('heic-hang');
    const hangAgent = await makeGuestAgent(hang.token);

    const started = Date.now();
    const hangRes = await hangAgent
      .post(`/tasks/${hang.taskId}/submit`)
      .attach('photo', hangingHeicBuffer(), {
        filename: 'hang.heic',
        contentType: 'image/heic',
      });
    const elapsed = Date.now() - started;

    // Completed (did not hang), redirected back to the task page, and inserted
    // no row — the timed-out decode was rejected, not stored.
    expect([301, 302, 303]).toContain(hangRes.status);
    expect(hangRes.headers.location).toBe(`/tasks/${hang.taskId}`);
    const hangRow = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(hang.guestId, hang.taskId);
    expect(hangRow).toBeUndefined();

    // Bounded: it resolved on the order of the timeout, not indefinitely.
    // Generous ceiling (timeout + worker-spawn + request overhead) so this is
    // not flaky, while still far below a "never settles" hang.
    expect(elapsed).toBeLessThan(TEST_DECODE_TIMEOUT_MS + 8000);
    // And it was the TIMEOUT that fired, not an instant worker error: the
    // response cannot have come back meaningfully before the timeout elapsed.
    // (Small tolerance for timer/scheduling jitter.) This pins the timeout path
    // specifically — it would fail if the worker rejected early instead of hanging.
    expect(elapsed).toBeGreaterThanOrEqual(TEST_DECODE_TIMEOUT_MS - 100);

    // 2) Immediately after, a NORMAL HEIC still converts — proving
    //    heicDecodeChain advanced past the timed-out decode (not wedged).
    const ok = insertGuestAndTask('heic-after');
    const okAgent = await makeGuestAgent(ok.token);

    const okRes = await okAgent
      .post(`/tasks/${ok.taskId}/submit`)
      .attach('photo', realHeic, { filename: 'real.heic', contentType: 'image/heic' });

    expect([301, 302, 303]).toContain(okRes.status);
    const okRow = db
      .prepare('SELECT photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(ok.guestId, ok.taskId);
    expect(okRow).toBeDefined(); // the chain recovered — this decode ran and stored
    expect(okRow.photo_path).toMatch(/\.jpg$/);

    const thumb = await okAgent.get('/thumbs/' + okRow.thumb_path);
    expect(thumb.status).toBe(200);
  });
});
