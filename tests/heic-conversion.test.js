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
const { stripComments } = require('./helpers/source-text');

let app;
let db;
let config;
let photos;
let realJpeg;
let realPng;
let realWebp;

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

  // #933 AC1: real decodable PNG/WebP buffers (same sharp({create: ...})
  // pattern as realJpeg above), so the octet-stream-sniff submissions below
  // are genuine images that must survive thumbnailing, not just pass the
  // signature check.
  realPng = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 40, g: 200, b: 210 } },
  })
    .png()
    .toBuffer();
  realWebp = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 220, g: 90, b: 30 } },
  })
    .webp()
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
// Re-scoped by #930: the HEIC-confirmed branch now ALSO takes a second
// bounded, positioned read (fs.readSync, up to HEIC_ADMISSION_SNIFF_BYTES)
// for the admission-time pixel-bomb sniff, before the one full-file read
// (still exactly one fs.readFileSync(fd), still the only such call, still
// after the per-guest rate-limit check) — the guard below still holds, just
// with a second bounded fs.readSync call alongside the original 12-byte one.
//
// The AC itself is phrased structurally ("Given src/services/photos.js after
// the change; When read; Then ..."), so this parses the function's own
// source text rather than spying on fs at runtime — a static claim about
// STRUCTURE (does the full read appear only after the branch point) is
// exactly what a source-text check proves, with no async-timing involved.
// An earlier attempt here to use a runtime fs.readFileSync spy instead was
// abandoned (recorded zero calls) and blamed on a vite-node/CJS module
// boundary per tests/config-branches.test.js's mock-safety note — #930's own
// AC4 below (which DOES need to prove a temporal/ordering property no
// source-text check can show — that the read is deferred until AFTER a
// decode slot is granted) revisited that and got a spy working reliably
// with a discriminating, always-delegating vi.spyOn(fs, 'readFileSync')
// mock, so that assumption does not hold in general; it is corrected here.
// This suite keeps the source-text approach for this AC anyway, because it
// is the more direct proof of a purely structural claim.
// ---------------------------------------------------------------------------
describe('#463 AC3: bounded header sniff, full read only on the HEIC-confirmed branch', () => {
  // Comments stripped up front (issue #939), via the shared helper, BEFORE
  // extractFunction's own indexOf/search bound-finding runs — so a doc/inline
  // comment that legitimately MENTIONS `fs.readFileSync(fd)` or a function
  // name while explaining the design can neither be miscounted as a call nor
  // fool the "next top-level function" boundary search below.
  const source = stripComments(
    fs.readFileSync(path.join(__dirname, '../src/services/photos.js'), 'utf8')
  );

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

  const body = extractFunction('resolveUploadedFile');

  it('performs a bounded 12-byte header read via openSync/readSync/closeSync', () => {
    expect(body).toMatch(/fs\.openSync\(/);
    expect(body).toMatch(/fs\.readSync\(/);
    expect(body).toMatch(/fs\.closeSync\(/);
  });

  it('#930: also performs a second bounded, positioned admission-sniff read (fs.readSync, up to HEIC_ADMISSION_SNIFF_BYTES) through the SAME fd, still inside the HEIC-confirmed branch', () => {
    // Two DISTINCT fs.readSync call sites now exist in this function: the
    // original 12-byte header sniff, and the admission-time pixel-bomb
    // sniff. Both must be fs.readSync (positioned, bounded), never
    // fs.readFileSync (unbounded, current-offset) -- see the next test for
    // the readFileSync-count guard that would catch a regression here.
    expect(body.match(/fs\.readSync\(/g).length).toBe(2);
    expect(body).toMatch(/fs\.readSync\(fd, sniffBuf, 0, config\.HEIC_ADMISSION_SNIFF_BYTES, 0\)/);
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
    // unconditional read alongside the new confirmed-branch read). #930: the
    // count does NOT double even though a second bounded sniff was added —
    // that second sniff is fs.readSync, never fs.readFileSync.
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
// Issue #933: Android SAF content pickers (and the HTML multipart algorithm
// itself, whenever File.type is empty) hand over a real JPEG/PNG/WebP under
// the generic application/octet-stream mimetype. Before this fix,
// resolveUploadedFile sniffed octet-stream ONLY for HEIC and rejected
// anything else under that mimetype as "not allowed" — deleting a guest's
// real photo. AC1 covers the fix (sniff + rename to the right extension);
// AC2 confirms the gate still does not widen to arbitrary bytes.
// ---------------------------------------------------------------------------
describe('#933 AC1: a real JPEG/PNG/WebP declared application/octet-stream is sniffed, retyped, and stored', () => {
  it.each([
    ['JPEG', () => realJpeg, '.jpg'],
    ['PNG', () => realPng, '.png'],
    ['WebP', () => realWebp, '.webp'],
  ])(
    '%s bytes under application/octet-stream persist under %s and the submission succeeds',
    async (label, getBuffer, expectedExt) => {
      const { guestId, taskId, token } = insertGuestAndTask(`heic-933-${label.toLowerCase()}`);
      const agent = await makeGuestAgent(token);

      const res = await agent.post(`/tasks/${taskId}/submit`).attach('photo', getBuffer(), {
        // No real Content-Type from the client — the Android SAF / empty
        // File.type case this issue exists for.
        filename: `android-photo-${label.toLowerCase()}`,
        contentType: 'application/octet-stream',
      });

      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toBe(`/tasks/${taskId}`);

      const row = db
        .prepare(
          'SELECT photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?'
        )
        .get(guestId, taskId);
      expect(row).toBeDefined(); // the submission was NOT rejected
      expect(row.photo_path.endsWith(expectedExt)).toBe(true);

      // The provisional `.heic` disk name (diskStorage.filename's fallback for
      // a mimetype not in ALLOWED_MIME_TO_EXT) was renamed away, not left
      // behind or copied.
      expect(heicFilesIn(config.UPLOADS_DIR)).toEqual([]);

      // Served back correctly, and the thumbnail generated -- proving the
      // stored bytes are genuinely the sniffed format, not junk that merely
      // matched a signature.
      const original = await agent.get('/uploads/' + row.photo_path);
      expect(original.status).toBe(200);
      const thumb = await agent.get('/thumbs/' + row.thumb_path);
      expect(thumb.status).toBe(200);
    }
  );
});

describe('#933 AC2: octet-stream bytes matching no known signature are still rejected', () => {
  it('a PDF-header buffer declared application/octet-stream is unlinked and rejected with the standard copy', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-933-pdf');
    const agent = await makeGuestAgent(token);

    const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

    // Handcrafted bytes (not sharp-generated -- this must NOT decode as any
    // allowed format): a real PDF magic-byte header.
    const pdfBytes = Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary');

    const res = await agent.post(`/tasks/${taskId}/submit`).attach('photo', pdfBytes, {
      filename: 'not-a-photo.pdf',
      contentType: 'application/octet-stream',
    });

    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe(`/tasks/${taskId}`);

    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined();

    // No new file left behind -- the gate did not widen to arbitrary bytes.
    expect(fs.readdirSync(config.UPLOADS_DIR).sort()).toEqual(uploadsBefore);

    const page = await agent.get(`/tasks/${taskId}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain(photos.ALLOWED_LABEL);
  });
});

// ---------------------------------------------------------------------------
// Issue #933 AC3: image/heic-sequence (hevc-branded) and image/heif-sequence
// (msf1-branded) must pass fileFilter (new HEIC_CANDIDATE_MIMES entries) and
// sniff as HEIC (msf1 was already an accepted brand; hevc is new) so they
// reach convertHeicToJpeg -- deliberately bounded at that entry point per the
// issue: the repo has no decodable hevc-branded fixture, so end-to-end decode
// success is not asserted. Both fixtures below are header-only (ftyp + a
// well-formed ispe, no HEVC payload) -- craftHeicHeader from
// tests/helpers/heic-fixtures.js now takes an optional `brand` param, used
// here to supply 'hevc'/'msf1' instead of the default 'heic'.
//
// Reaching convertHeicToJpeg is proven by the FLASH MESSAGE: a rejection at
// the earlier "declared type doesn't map / doesn't sniff as jpeg-png-webp-
// heic" gate would say photos.ALLOWED_LABEL ("not allowed... JPEG, PNG, or
// WebP"); a header-only HEIC that DID reach the decode fails inside the
// worker instead ("HEIF image not found" -- an uncoded error, so
// resolveUploadedFile wraps it in the generic "couldn't be read" copy, per
// GUEST_SAFE_CONVERT_CODES) -- the same observable shape as the existing
// "worker decode failure" suite's 100x100 'heic'-branded fixture below, just
// with the new brand and mimetype.
// ---------------------------------------------------------------------------

describe('#933 AC3: heic-sequence / heif-sequence candidate mimes sniff by ftyp brand and reach the convert path', () => {
  it.each([
    ['hevc', 'image/heic-sequence'],
    ['msf1', 'image/heif-sequence'],
    ['hevx', 'image/heic-sequence'],
  ])(
    'a %s-branded fixture declared %s passes fileFilter, sniffs as HEIC, and reaches convertHeicToJpeg',
    async (brand, mimetype) => {
      const { guestId, taskId, token } = insertGuestAndTask(`heic-933-${brand}`);
      const agent = await makeGuestAgent(token);

      const uploadsBefore = fs.readdirSync(config.UPLOADS_DIR).sort();

      const res = await agent
        .post(`/tasks/${taskId}/submit`)
        .attach('photo', craftHeicHeader(100, 100, brand), {
          filename: 'live-photo.heic',
          contentType: mimetype,
        });

      // The request completed normally (fileFilter accepted the mimetype --
      // a rejection there would still redirect too, so this alone isn't the
      // proof; the message check below is).
      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toBe(`/tasks/${taskId}`);

      const row = db
        .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
        .get(guestId, taskId);
      expect(row).toBeUndefined(); // no decodable payload -- rejected, but AFTER reaching convert

      expect(fs.readdirSync(config.UPLOADS_DIR).sort()).toEqual(uploadsBefore);
      expect(heicFilesIn(config.UPLOADS_DIR)).toEqual([]);

      // Proves it reached convertHeicToJpeg rather than being rejected at the
      // earlier type gate: the "not allowed" copy is ABSENT, because this
      // failure came from the worker's decode error, wrapped in the distinct
      // generic "couldn't be read" copy instead (checked apostrophe-free —
      // EJS's default escapeFn renders `'` as `&#39;` in the response body).
      const page = await agent.get(`/tasks/${taskId}`);
      expect(page.status).toBe(200);
      expect(page.text).not.toContain(photos.ALLOWED_LABEL);
      expect(page.text).toContain('Sorry, that photo');
    }
  );
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

// ---------------------------------------------------------------------------
// Issue #930: the HEIC busy-cap now admits through heicDecodeSemaphore
// (src/utils/semaphore.js) instead of the retired heicDecodeChain promise
// chain + pendingHeicDecodes counter, with a deferred-read supplier and a
// two-stage pixel-bomb check. These run under this file's DEFAULT config
// regime (no env pins) -- see tests/heic-decode-pending-cap.test.js for the
// env-pinned ceiling/wait-expiry ACs (AC2/AC3), which need a small cap and
// the hanging-worker seam this file deliberately does not set up.
// ---------------------------------------------------------------------------

describe('#930 AC1: HEIC busy-cap config defaults', () => {
  it('MAX_PENDING_HEIC_DECODES is 12 and HEIC_QUEUE_WAIT_MS is 45000 under default config', () => {
    // Red before #930: MAX_PENDING_HEIC_DECODES was 8 and HEIC_QUEUE_WAIT_MS
    // did not exist.
    expect(config.MAX_PENDING_HEIC_DECODES).toBe(12);
    expect(config.HEIC_QUEUE_WAIT_MS).toBe(45000);
  });
});

describe('#930 AC4: the full-file read is deferred until a decode slot is granted', () => {
  it('does not read the full file while queued behind a held slot, and reads it exactly once after the slot frees', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-930-ac4-defer');
    const agent = await makeGuestAgent(token);

    // Instrument fs.readFileSync -- discriminate on a NUMBER first argument
    // (an fd, i.e. the full-file read convertHeicToJpeg's supplier performs)
    // vs a STRING (a path, e.g. this very file reading the fixture, or any
    // unrelated read elsewhere in the app) so only the read under test is
    // counted. Always delegates to the real implementation (never replaces
    // behavior), matching the safe-mock-vs-dangerous-mock distinction
    // tests/config-branches.test.js's own file header documents for this
    // exact vi.spyOn(fs, 'readFileSync') seam.
    const realReadFileSync = fs.readFileSync;
    const fdReadTimestamps = [];
    const spy = vi.spyOn(fs, 'readFileSync').mockImplementation(function (...args) {
      if (typeof args[0] === 'number') fdReadTimestamps.push(Date.now());
      return realReadFileSync.apply(fs, args);
    });

    // Hold the ONE decode slot ourselves, before the request ever reaches
    // convertHeicToJpeg -- the same manual-acquire idiom
    // tests/memories.test.js's issue #857 upload-slot test uses for
    // uploadSemaphore (import-the-live-instance pattern, tests/memories.test.js:71).
    await photos.heicDecodeSemaphore.acquire();

    let response;
    let requestErr;
    const pending = agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', HEIC_FIXTURE, { filename: 'ac4-defer.heic', contentType: 'image/heic' })
      .then(
        (res) => {
          response = res;
        },
        (err) => {
          requestErr = err;
        }
      );

    try {
      // Give the request time to clear multer, the 12-byte sniff, the
      // per-guest rate limit, the admission ceiling + stage-1 check, and
      // reach heicDecodeSemaphore.acquire() -- everything BEFORE the
      // full-file read. With the slot held, the read cannot have happened no
      // matter how long this waits: that is the guarantee under test, not a
      // timing race (same reasoning as the #857 upload-slot test).
      await new Promise((resolve) => setTimeout(resolve, 150));
      // RED before #930: the old eager-read code performed this read at
      // admission time, before ever touching the (then nonexistent) slot --
      // this would already be 1 here on the unfixed code.
      expect(fdReadTimestamps.length).toBe(0);
    } finally {
      photos.heicDecodeSemaphore.release();
      // Always drain the in-flight request before leaving the test (same
      // reasoning as the #857 upload-slot test: a straggler request racing a
      // retried attempt for the same singleton semaphore would make the
      // retry unreadable), and always restore the spy.
      await pending;
      spy.mockRestore();
    }

    expect(requestErr).toBeUndefined();
    expect([301, 302, 303]).toContain(response.status);
    // Exactly one full-file read total, and it happened only once the slot
    // was released above.
    expect(fdReadTimestamps.length).toBe(1);

    const row = db
      .prepare('SELECT photo_path FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeDefined();
    expect(row.photo_path).toMatch(/\.jpg$/);
  });

  it('an over-pixel-cap HEIC with ispe in its leading bytes is refused without consuming a slot', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-930-ac4-noslot');
    const agent = await makeGuestAgent(token);

    const before = {
      active: photos.heicDecodeSemaphore.active,
      pending: photos.heicDecodeSemaphore.pending,
    };

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', craftHeicHeader(16000, 16000), {
        filename: 'ac4-noslot-bomb.heic',
        contentType: 'image/heic',
      });

    expect([301, 302, 303]).toContain(res.status);
    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined();

    // Rejected at admission (the ispe sits in the leading bytes, well inside
    // the sniff prefix) -- the semaphore's counts are exactly what they were
    // before, proving no slot was ever requested for this file.
    expect(photos.heicDecodeSemaphore.active).toBe(before.active);
    expect(photos.heicDecodeSemaphore.pending).toBe(before.pending);
  });
});

describe('#930 AC5: a late meta/ispe (beyond the admission sniff prefix) is handled by the stage-2 full-buffer check', () => {
  it('grounds the 256 KB admission-sniff constant against the real fixture', () => {
    // The real fixture's own ispe box sits well inside the default
    // HEIC_ADMISSION_SNIFF_BYTES prefix -- this is the "leading meta box"
    // claim config.js's own comment makes for a normally-muxed phone HEIC,
    // measured here rather than asserted from folklore. (-4: the ispe box's
    // own 4-byte size field precedes the 'ispe' type marker itself.)
    const ispeMarkerAt = HEIC_FIXTURE.indexOf(Buffer.from('ispe', 'ascii'));
    expect(ispeMarkerAt).toBeGreaterThan(0);
    const ispeBoxStart = ispeMarkerAt - 4;
    expect(ispeBoxStart).toBeGreaterThan(0);
    expect(ispeBoxStart).toBeLessThan(config.HEIC_ADMISSION_SNIFF_BYTES);
  });

  // ftyp (16 bytes) + zero padding pushing the ispe box PAST the default
  // HEIC_ADMISSION_SNIFF_BYTES prefix + the same 20-byte ispe box
  // craftHeicHeader builds -- so the admission-time sniff (bounded to
  // HEIC_ADMISSION_SNIFF_BYTES) finds NO ispe at all (stage 1 is
  // inconclusive), forcing the two-stage check to fall through to stage 2 on
  // the full buffer, exactly the "legal ISO-BMFF, late meta box" case #930
  // exists to not falsely reject.
  function craftLateMetaHeicHeader(width, height) {
    const full = craftHeicHeader(width, height); // ftyp(16) + ispe(20)
    const ftyp = full.subarray(0, 16);
    const ispe = full.subarray(16);
    const padding = Buffer.alloc(config.HEIC_ADMISSION_SNIFF_BYTES);
    return Buffer.concat([ftyp, padding, ispe]);
  }

  it('a within-cap late-meta HEIC is NOT rejected as oversize (reaches the worker instead of being refused at admission)', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-930-ac5-ok');
    const agent = await makeGuestAgent(token);

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', craftLateMetaHeicHeader(4000, 3000), {
        filename: 'late-meta-ok.heic',
        contentType: 'image/heic',
      });

    expect([301, 302, 303]).toContain(res.status);
    // No real HEVC payload behind this crafted header, so it still fails --
    // but AT THE WORKER, not at the pixel-bomb gate (proving the two-stage
    // check let it through rather than falsely refusing it as oversize).
    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined();

    const page = await agent.get(`/tasks/${taskId}`);
    // NOT the "not allowed" copy (an admission-stage rejection) and NOT the
    // oversize copy either -- the distinct generic decode-failure copy,
    // proving it reached decodeHeicInWorker.
    expect(page.text).not.toContain(photos.ALLOWED_LABEL);
    expect(page.text).not.toContain('too large to process here');
    expect(page.text).toContain('Sorry, that photo');
  });

  it('an over-cap late-meta HEIC IS rejected with the oversize error at its turn, and the slot is released (no worker ever spawned for it)', async () => {
    const { guestId, taskId, token } = insertGuestAndTask('heic-930-ac5-bomb');
    const agent = await makeGuestAgent(token);

    const before = {
      active: photos.heicDecodeSemaphore.active,
      pending: photos.heicDecodeSemaphore.pending,
    };

    const res = await agent
      .post(`/tasks/${taskId}/submit`)
      .attach('photo', craftLateMetaHeicHeader(16000, 16000), {
        filename: 'late-meta-bomb.heic',
        contentType: 'image/heic',
      });

    expect([301, 302, 303]).toContain(res.status);
    const row = db
      .prepare('SELECT id FROM submissions WHERE guest_id = ? AND task_id = ?')
      .get(guestId, taskId);
    expect(row).toBeUndefined();

    const page = await agent.get(`/tasks/${taskId}`);
    expect(page.text).toContain('too large to process here');

    // The slot was acquired (stage 2 only runs after the buffer supplier
    // does, which only runs after acquire()) and then released on the
    // stage-2 throw -- counts are back at baseline, and decodeHeicInWorker
    // was never reached (the throw happens strictly before it).
    expect(photos.heicDecodeSemaphore.active).toBe(before.active);
    expect(photos.heicDecodeSemaphore.pending).toBe(before.pending);
  });
});
