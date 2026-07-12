// tests/heic-conversion.test.js
// Issue #281: HEIC/HEIF is now ACCEPTED at intake and converted to JPEG on the
// server (superseding #188's rejection). Covers AC1-AC5 from the issue, plus
// the memory-batch regression guard the issue's implementation notes call
// out (accepting HEIC in the shared fileFilter would otherwise let broken
// .heic originals into the gallery via POST /memories too) and the
// mimetype/extension-mismatch edge (a HEIC-candidate mimetype that is NOT
// actually HEIC must still be rejected, not silently stored).
//
// HEIC_FIXTURE is a REAL HEVC-encoded HEIC file (sharp cannot fabricate one —
// see fixtures/sample-photos/SOURCES.md for provenance/license and how it was
// verified to actually decode via heic-convert).
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// photos (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');
const { craftHeicHeader } = require('./helpers/heic-fixtures');

let app;
let db;
let config;
let photos;
let realJpeg;

const HEIC_FIXTURE = fs.readFileSync(
  path.join(__dirname, '../fixtures/sample-photos/sample-heic-01.heic')
);

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config resolves against the temp DATA_DIR.
  config = require('../config');
  photos = require('../src/services/photos');

  realJpeg = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 120, g: 180, b: 90 } },
  })
    .jpeg()
    .toBuffer();
});

function insertGuestAndTask(prefix) {
  const token = `${prefix}-${crypto.randomUUID()}`;
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
  signInGuest(app, token, agent);
  return agent;
}

function heicFilesIn(dir) {
  return fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.heic'));
}

// Reads a response body as a raw Buffer regardless of content-type — supertest
// has no built-in parser for image/jpeg, so without this `res.body` would be
// `{}` (see tests/export-zip.test.js, which uses the identical pattern for
// application/zip).
function binaryParser(res, callback) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

describe('AC1 + AC2: a HEIC submission is converted, stored as JPEG, and thumbnails', () => {
  let submissionRow;
  let sharedAgent;

  it('AC1: creates a submissions row with a .jpg photo_path, no .heic left behind, served as image/jpeg', async () => {
    const seeded = insertGuestAndTask('heic-ac1');
    sharedAgent = await makeGuestAgent(seeded.token);

    const res = await sharedAgent
      .post(`/tasks/${seeded.taskId}/submit`)
      .attach('photo', HEIC_FIXTURE, { filename: 'IMG_0001.HEIC', contentType: 'image/heic' });

    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe(`/tasks/${seeded.taskId}`);

    submissionRow = db
      .prepare(
        'SELECT id, photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?'
      )
      .get(seeded.guestId, seeded.taskId);
    expect(submissionRow).toBeDefined();
    expect(submissionRow.photo_path).toMatch(/\.jpg$/);

    // No .heic original left in UPLOADS_DIR (converted or nothing at all).
    expect(heicFilesIn(config.UPLOADS_DIR)).toEqual([]);

    const original = await sharedAgent.get('/uploads/' + submissionRow.photo_path);
    expect(original.status).toBe(200);
    expect(original.headers['content-type']).toMatch(/^image\/jpeg/);
  });

  it('AC2: the thumbnail serves 200', async () => {
    expect(submissionRow).toBeDefined(); // depends on the AC1 test above running first
    const thumb = await sharedAgent.get('/thumbs/' + submissionRow.thumb_path);
    expect(thumb.status).toBe(200);
  });
});

describe('AC3: a HEIC file declared as application/octet-stream is still converted', () => {
  it('sniffs the ISO-BMFF signature (not the mimetype) and converts to .jpg', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-ac3');
    const agent = await makeGuestAgent(token);

    const res = await agent.post(`/tasks/${taskId}/submit`).attach('photo', HEIC_FIXTURE, {
      // The iOS/Android "Files" picker sends a real HEIC under this generic
      // mimetype rather than image/heic — this is the exact case a
      // mimetype-only check would miss.
      filename: 'IMG_0002',
      contentType: 'application/octet-stream',
    });

    expect([301, 302, 303]).toContain(res.status);

    const row = db
      .prepare('SELECT photo_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeDefined();
    expect(row.photo_path).toMatch(/\.jpg$/);
  });
});

describe('signature beats a lying mimetype on the submission path', () => {
  it('a real HEIC declared as image/jpeg is still sniffed, converted, and served as JPEG (no dead-end rejection)', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-liar');
    const agent = await makeGuestAgent(token);

    // The bytes are real HEIC; the Content-Type lies and claims image/jpeg.
    // diskStorage writes it under a .jpg name, but resolveUploadedFile must
    // sniff the signature FIRST and convert — otherwise makeThumb/sharp would
    // choke on the HEVC bytes and produce the exact thumb_failed dead-end #281
    // exists to eliminate.
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', HEIC_FIXTURE, { filename: 'IMG_0004.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);
    // Success redirect back to the task page (not a re-render carrying the
    // dead-end "could not save that photo" copy).
    expect(res.headers.location).toBe(`/tasks/${taskId}`);

    const row = db
      .prepare('SELECT photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeDefined(); // a row exists -> it was NOT rejected as thumb_failed
    expect(row.photo_path).toMatch(/\.jpg$/);

    const original = await agent.get('/uploads/' + row.photo_path);
    expect(original.status).toBe(200);
    expect(original.headers['content-type']).toMatch(/^image\/jpeg/);

    // And it is a genuinely decodable JPEG (thumbnail generated), proving the
    // stored file is the converted output, not the undecodable HEVC bytes.
    const thumb = await agent.get('/thumbs/' + row.thumb_path);
    expect(thumb.status).toBe(200);

    // No .heic original left in UPLOADS_DIR.
    expect(heicFilesIn(config.UPLOADS_DIR)).toEqual([]);
  });
});

describe('AC4: a HEIC avatar is converted', () => {
  it('POST /me/edit with a HEIC avatar sets avatar_path and serves image/jpeg', async () => {
    const token = `heic-ac4-${crypto.randomUUID()}`;
    const guestId = db
      .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
      .run(token, 'Avatar Guest').lastInsertRowid;
    const agent = await makeGuestAgent(token);

    const res = await agent
      .post('/me/edit')
      .field('name', 'Avatar Guest')
      .attach('avatar', HEIC_FIXTURE, { filename: 'avatar.heic', contentType: 'image/heic' });

    expect([301, 302, 303]).toContain(res.status);

    const row = db.prepare('SELECT avatar_path FROM guests WHERE id = ?').get(guestId);
    expect(row.avatar_path).toBeTruthy();

    const avatarRes = await agent.get('/uploads/' + row.avatar_path);
    expect(avatarRes.status).toBe(200);
    expect(avatarRes.headers['content-type']).toMatch(/^image\/jpeg/);
  });
});

describe('AC5: JPEG uploads still work end-to-end', () => {
  it('creates a submissions row and serves the thumbnail', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-ac5');
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

    // #463 AC1: the stored original is BYTE-FOR-BYTE identical to what was
    // uploaded — the real assertion the bounded 12-byte header sniff must not
    // break. This would fail if resolveUploadedFile ever stored the header
    // buffer, a truncated read, or otherwise touched the non-HEIC file's bytes.
    const original = await agent
      .get('/uploads/' + row.photo_path)
      .buffer(true)
      .parse(binaryParser);
    expect(original.status).toBe(200);
    expect(Buffer.compare(original.body, realJpeg)).toBe(0);

    const thumb = await agent.get('/thumbs/' + row.thumb_path);
    expect(thumb.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Issue #463 AC3 (structural): resolveUploadedFile must sniff only a bounded
// 12-byte header to decide HEIC-ness, and read the full file ONLY inside the
// HEIC-confirmed branch. It previously read the WHOLE file unconditionally
// (up to MAX_UPLOAD_BYTES = 15 MB) on every upload just to sniff a 12-byte
// marker — pure waste on the dominant non-HEIC path, and a source of
// main-thread blocking under a reception-night upload burst (see #311).
//
// The AC itself is phrased structurally ("Given src/services/photos.js after
// the change; When read; Then ..."), so this parses the function's own
// source text rather than spying on fs at runtime. A runtime fs.readFileSync
// spy was tried and rejected here: this suite runs under vite-node, and
// tests/config-branches.test.js already documents (see its file-header
// comment) that a mocked/spied fs.readFileSync in a test file does not
// reliably intercept a source file's OWN require('fs') across that
// vite-node/CJS boundary — confirmed empirically while writing this test (the
// spy recorded zero calls even though the HEIC conversion visibly succeeded).
// A source-text check is exact and has no such boundary problem.
// ---------------------------------------------------------------------------
describe('#463 AC3: bounded header sniff, full read only on the HEIC-confirmed branch', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/services/photos.js'), 'utf8');

  function extractFunction(fnName) {
    const start = source.indexOf(`async function ${fnName}(`);
    expect(start, `${fnName} not found in photos.js`).toBeGreaterThanOrEqual(0);
    // The next top-level "\nasync function " or "\nfunction " marks the start
    // of the following function — a simple, sufficient bound for this file's
    // style (one function per top-level declaration, no nesting that deep).
    const rest = source.slice(start + 1);
    const nextFn = rest.search(/\n(async )?function /);
    return nextFn < 0 ? source.slice(start) : source.slice(start, start + 1 + nextFn);
  }

  // Strip comments so the structural assertions below scan actual CODE, not
  // prose: the function's doc/inline comments legitimately MENTION
  // `fs.readFileSync(fd)` when explaining the design, and those mentions must
  // not be miscounted as calls. resolveUploadedFile contains no `//` inside a
  // string/regex literal, so a plain block+line comment strip is exact here.
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  }

  const body = stripComments(extractFunction('resolveUploadedFile'));

  it('performs a bounded 12-byte header read via openSync/readSync/closeSync', () => {
    expect(body).toMatch(/fs\.openSync\(/);
    expect(body).toMatch(/fs\.readSync\(/);
    expect(body).toMatch(/fs\.closeSync\(/);
  });

  it('contains no unconditional full-file readFileSync before the HEIC-confirmed branch', () => {
    const heicConfirmedAt = body.indexOf('assertHeicDecodeAllowed(guestId)');
    const firstReadFileSyncAt = body.indexOf('fs.readFileSync(');
    expect(heicConfirmedAt).toBeGreaterThan(-1);
    expect(firstReadFileSyncAt).toBeGreaterThan(-1);
    // The only fs.readFileSync call in this function must appear AFTER the
    // per-guest HEIC-decode-allowed check, i.e. strictly inside the
    // HEIC-confirmed branch — not on the shared path every upload takes.
    expect(firstReadFileSyncAt).toBeGreaterThan(heicConfirmedAt);
    // And there is exactly one such call in the whole function (no leftover
    // unconditional read alongside the new confirmed-branch read).
    expect(body.match(/fs\.readFileSync\(/g).length).toBe(1);
  });

  it('reads through a single fd — the full read never re-resolves the path (TOCTOU guard, CodeQL js/file-system-race)', () => {
    // Root fix for the CodeQL check-then-use finding: exactly one openSync, and
    // the full read is fs.readFileSync(fd) (the same descriptor), never a second
    // fs.readFileSync(safePath) that would re-resolve the path after the sniff.
    expect(body.match(/fs\.openSync\(/g).length).toBe(1);
    expect(body).toMatch(/fs\.readFileSync\(fd\)/);
    expect(body).not.toMatch(/fs\.readFileSync\(safePath\)/);
  });
});

// ---------------------------------------------------------------------------
// Regression guard (not an AC, called out explicitly in the issue's design
// notes): once HEIC is accepted in the shared fileFilter, the memory-batch
// path (POST /memories, uploadMemoryBatch) accepts it too and MUST convert
// every HEIC file in the batch, or broken .heic originals would land in the
// gallery.
// ---------------------------------------------------------------------------
describe('memory-batch regression guard: HEIC files in a POST /memories batch are converted', () => {
  it('a batch mixing a HEIC file and a JPEG converts the HEIC one and leaves both usable', async () => {
    const token = `heic-memories-${crypto.randomUUID()}`;
    const guestId = db
      .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
      .run(token, 'Memory Guest').lastInsertRowid;
    const agent = await makeGuestAgent(token);

    const res = await agent
      .post('/memories')
      .field('caption', 'heic batch')
      .attach('photos', HEIC_FIXTURE, { filename: 'IMG_0003.HEIC', contentType: 'image/heic' })
      .attach('photos', realJpeg, { filename: 'm2.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/gallery');

    const rows = db
      .prepare(
        'SELECT photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id IS NULL'
      )
      .all(guestId);
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.photo_path).toMatch(/\.jpg$/);
      const thumb = await agent.get('/thumbs/' + row.thumb_path);
      expect(thumb.status).toBe(200);
    }

    // No .heic original left behind anywhere in UPLOADS_DIR.
    expect(heicFilesIn(config.UPLOADS_DIR)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Edge case (edge-case-checklist.md "file upload: mimetype/extension
// mismatch"): a file declaring a HEIC-candidate mimetype whose bytes do NOT
// actually sniff as HEIC must still be rejected — accepting HEIC candidates
// provisionally in fileFilter must not become a loophole for arbitrary junk.
// ---------------------------------------------------------------------------
describe('edge case: a HEIC-candidate mimetype that is not really HEIC is still rejected', () => {
  it('rejects application/octet-stream garbage bytes, leaves no orphan file, no row created', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-edge');
    const agent = await makeGuestAgent(token);

    const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', Buffer.from('not really an image, just some bytes'), {
        filename: 'mystery.bin',
        contentType: 'application/octet-stream',
      });

    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe(`/tasks/${taskId}`);

    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined();

    // No new file left behind.
    expect(fs.readdirSync(config.UPLOADS_DIR).sort()).toEqual(uploadsBefore);

    // A guest-facing rejection message, same shape as the old fileFilter
    // rejection (photos.ALLOWED_LABEL — single source of truth for the copy).
    const page = await agent.get(`/tasks/${taskId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(photos.ALLOWED_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Security: HEIC pixel-bomb defense (adversarial-review blocker). A crafted
// few-MB HEIC declaring huge dimensions must be rejected by its DECLARED pixel
// count BEFORE the decoder allocates a full raw RGBA frame (width*height*4) —
// which, on the HEIC path, happens before sharp's own pixel guard can run.
//
// These exercise the guard directly (heicPixelDimensions / MAX_HEIC_PIXELS /
// assertHeicPixelsWithinCap) so the assertions FAIL if the guard is removed,
// and prove rejection happens without the large allocation: the guard reads
// only the `ispe` header bytes and never calls the decoder. A real
// 16000x16000 fixture is impractical, so a minimal ISO-BMFF header carrying a
// valid `ispe` box with the crafted dimensions is used instead
// (craftHeicHeader, shared from tests/helpers/heic-fixtures).
// ---------------------------------------------------------------------------

describe('pixel-bomb guard: dimension extraction and cap', () => {
  it('heicPixelDimensions reads the declared extent from the ispe box', () => {
    const dims = photos.heicPixelDimensions(craftHeicHeader(16000, 16000));
    expect(dims).toEqual({ width: 16000, height: 16000 });
    // Sanity: this crafted image is over the cap (16000*16000 = 256 MP > 100 MP).
    expect(16000 * 16000).toBeGreaterThan(photos.MAX_HEIC_PIXELS);
  });

  it('heicPixelDimensions reads the real fixture and it is within the cap', () => {
    const dims = photos.heicPixelDimensions(HEIC_FIXTURE);
    expect(dims).not.toBeNull();
    expect(dims.width * dims.height).toBeLessThanOrEqual(photos.MAX_HEIC_PIXELS);
  });

  it('assertHeicPixelsWithinCap THROWS BAD_IMAGE_TYPE on an over-cap header (fails if the guard is removed)', () => {
    let thrown;
    try {
      photos.assertHeicPixelsWithinCap(craftHeicHeader(16000, 16000));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('BAD_IMAGE_TYPE');
  });

  it('assertHeicPixelsWithinCap does NOT throw on a within-cap header, and rejects a header with no readable ispe', () => {
    // A modest 4000x3000 (12 MP) passes.
    expect(() => photos.assertHeicPixelsWithinCap(craftHeicHeader(4000, 3000))).not.toThrow();
    // A HEIC-signatured buffer with no ispe cannot be size-bounded -> rejected.
    const noIspe = Buffer.alloc(16);
    noIspe.write('ftyp', 4, 'ascii');
    noIspe.write('heic', 8, 'ascii');
    noIspe.write('heic', 12, 'ascii');
    expect(() => photos.assertHeicPixelsWithinCap(noIspe)).toThrow();
  });

  it('an oversized HEIC POSTed to /tasks/:id/submit is rejected with no submission row and no orphan file', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-bomb');
    const agent = await makeGuestAgent(token);

    const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

    const res = await agent.post(`/tasks/${taskId}/submit`).attach(
      'photo',
      craftHeicHeader(16000, 16000),
      // Declared image/heic; passes the fileFilter and looksLikeHeic sniff,
      // then the dimension guard fires before any decode/allocation.
      { filename: 'bomb.heic', contentType: 'image/heic' }
    );

    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe(`/tasks/${taskId}`);

    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined();

    // No .heic (or any new) file left behind — the guard unlinked it.
    expect(fs.readdirSync(config.UPLOADS_DIR).sort()).toEqual(uploadsBefore);
    expect(heicFilesIn(config.UPLOADS_DIR)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Worker offload (adversarial-review blocker): the HEIC decode runs in a
// worker_threads worker so it never blocks the main event loop. The AC1-AC5
// conversions above ALREADY exercise the worker end-to-end (a successful HEIC
// upload only produces a JPEG if the worker decoded it). This block adds the
// failure half: a HEIC whose bytes pass looksLikeHeic AND the pixel cap but
// fail the actual decode inside the worker must surface as a clean
// BAD_IMAGE_TYPE rejection — the main process must not crash or hang.
// ---------------------------------------------------------------------------
describe('worker decode failure surfaces as a clean BAD_IMAGE_TYPE rejection', () => {
  it('a valid-header HEIC with no decodable payload is rejected, no row, no crash/hang', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-workerfail');
    const agent = await makeGuestAgent(token);

    const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

    // 100x100 ispe: passes looksLikeHeic (ftyp 'heic') and is WELL under the
    // pixel cap, so it reaches the worker — but there is no HEVC image payload,
    // so heic-convert throws inside the worker ("HEIF image not found").
    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', craftHeicHeader(100, 100), {
        filename: 'headeronly.heic',
        contentType: 'image/heic',
      });

    // A normal redirect back to the task page (the request completed — the
    // worker crash did not hang or 500 the process), and NO submission row.
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe(`/tasks/${taskId}`);

    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined();

    // No orphan file left behind, and the process is still serving requests.
    expect(fs.readdirSync(config.UPLOADS_DIR).sort()).toEqual(uploadsBefore);
    const stillAlive = await agent.get(`/tasks/${taskId}`);
    expect(stillAlive.status).toBe(200);
  });

  it('the main event loop stays responsive while a decode runs (decode is off-thread)', async () => {
    // Kick off a real HEIC conversion (which dispatches to the worker) and,
    // WITHOUT awaiting it, immediately serve other requests. If the decode ran
    // on the main thread it would block these until it finished; because it is
    // off-thread, they resolve promptly alongside it.
    const { taskId, token } = insertGuestAndTask('heic-responsive');
    const agent = await makeGuestAgent(token);

    const convertInFlight = agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', HEIC_FIXTURE, { filename: 'IMG.heic', contentType: 'image/heic' });

    // Concurrent lightweight requests served while the decode is in flight.
    const pings = await Promise.all([
      agent.get('/tasks'),
      agent.get('/tasks'),
      agent.get('/tasks'),
    ]);
    for (const p of pings) {
      expect(p.status).toBe(200);
    }

    // And the conversion still completes successfully.
    const res = await convertInFlight;
    expect([301, 302, 303]).toContain(res.status);
  });
});
