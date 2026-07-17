// tests/avatar-upload-limit.test.js
//
// Issue #118: config.js used to define its own (stale) MAX_UPLOAD_BYTES and
// src/routes/auth.js enforced THAT value on avatar uploads, while
// src/services/photos.js enforced a different value on task-submission
// photos. Two live, disagreeing limits on the same kind of file.
//
// auth.js now reads photos.MAX_UPLOAD_BYTES directly (see src/routes/auth.js),
// so avatars and task submissions share exactly one numeric ceiling. This test
// pins that: it drives the real POST /join route (not a unit check of
// photos.js in isolation) with a buffer just OVER the shared limit and one
// just UNDER it, and asserts the app accepts/rejects the FILE accordingly.
//
// Issue #244 retired the separate /onboard step this file used to drive —
// avatar intake happens during signup now (#240). That also changed what
// "rejects" means here: /join never blocks signup on a bad/oversized avatar
// (routes/auth.js's `avatarRejected` branch) — it silently drops the file and
// still creates the guest. So the over-limit case below asserts the FILE is
// rejected (no avatar_path stored) while signup itself still succeeds; the
// under-limit case asserts the file is accepted and stored. If auth.js ever
// reverts to a separate or hard-coded limit (e.g. the old 12 MB config
// value), the "just under photos.MAX_UPLOAD_BYTES" case would start failing
// here even though it is comfortably under photos.js's own number — that is
// what catches the divergence.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or app
// (see tests/helpers/testApp.js).
'use strict';

const request = require('supertest');
const sharp = require('sharp');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
// Set inside beforeAll, AFTER loadApp() — requiring photos.js (which requires
// config.js and db.js) before loadApp() sets DATA_DIR/DB_PATH would bind this
// whole test file to the real project database instead of the temp one (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
let MAX_UPLOAD_BYTES;
let OVER_LIMIT_SIZE;
let UNDER_LIMIT_SIZE;

/**
 * Build a real, sharp-decodable JPEG padded out to exactly `totalBytes`.
 *
 * saveAvatar() runs the upload through sharp, so an "under the limit" test
 * needs a file multer's byte-count check AND sharp's decoder both accept —
 * a buffer of arbitrary bytes fails to decode and the route 500s for the
 * wrong reason. Padding is added as JPEG COM (comment, marker 0xFFFE)
 * segments spliced in right after the SOI marker: decoders skip any segment
 * they don't recognize by its declared length, so stacking enough COM
 * segments (each capped at 0xFFFF bytes including its 2-byte length header)
 * grows the file to an exact target size without touching the real image
 * data that follows.
 *
 * @param {number} totalBytes - exact output file size in bytes
 * @returns {Promise<Buffer>}
 */
async function buildPaddedJpeg(totalBytes) {
  const base = await sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer();
  const soi = base.slice(0, 2);
  const rest = base.slice(2);

  const paddingNeeded = totalBytes - base.length;
  const MARKER_BYTES = 2; // the 0xFF 0xFE marker itself, not counted in the segment length
  const MAX_SEG_PAYLOAD = 0xffff - 2; // segment length field includes its own 2 length bytes
  const segments = [];
  let remaining = paddingNeeded;
  while (remaining > 0) {
    // Each segment costs MARKER_BYTES + 2 (length field) + payload bytes overall.
    const payloadLen = Math.min(MAX_SEG_PAYLOAD, remaining - MARKER_BYTES - 2);
    const segLen = payloadLen + 2;
    segments.push(Buffer.from([0xff, 0xfe, (segLen >> 8) & 0xff, segLen & 0xff]));
    segments.push(Buffer.alloc(payloadLen, 0x20));
    remaining -= MARKER_BYTES + 2 + payloadLen;
  }

  return Buffer.concat([soi, ...segments, rest]);
}

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so photos.js's requires of config/db bind to the
  // temp DATA_DIR/DB_PATH, not the real project database.
  MAX_UPLOAD_BYTES = require('../src/services/photos').MAX_UPLOAD_BYTES;
  // Multer counts multipart field overhead too, so pad comfortably past the
  // boundary in each direction rather than testing at the exact byte.
  OVER_LIMIT_SIZE = MAX_UPLOAD_BYTES + 1024;
  UNDER_LIMIT_SIZE = MAX_UPLOAD_BYTES - 1024;
});

describe('avatar upload limit shares photos.MAX_UPLOAD_BYTES — issue #118', () => {
  it('drops an avatar buffer just OVER photos.MAX_UPLOAD_BYTES but still signs the guest up', async () => {
    const oversizedBuffer = Buffer.alloc(OVER_LIMIT_SIZE, 1);
    const res = await request(app)
      .post('/join')
      .field('name', 'Over Limit Guest')
      .field('contact', 'limit-over@example.com')
      .field('pin', '1111')
      .attach('avatar', oversizedBuffer, { filename: 'big.jpg', contentType: 'image/jpeg' });

    // /join never blocks signup on a rejected avatar (routes/auth.js's
    // avatarRejected branch) — it still redirects home. If auth.js used a
    // smaller limit than photos.MAX_UPLOAD_BYTES this would already reject
    // for a different reason, but pairing it with the "just under" case below
    // is what actually pins the shared value (see that test).
    expect([301, 302, 303]).toContain(res.status);

    const guest = db
      .prepare('SELECT onboarded, avatar_path FROM guests WHERE contact = ?')
      .get('limit-over@example.com');
    // Issue #564: onboarded starts at the schema default (0) after signup —
    // only GET /how-to-play ever flips it.
    expect(guest.onboarded).toBe(0);
    // The oversized file itself was rejected by multer's fileSize limit and
    // never saved — this is the actual "over the limit" assertion.
    expect(guest.avatar_path).toBeNull();
  });

  it('accepts an avatar buffer just UNDER photos.MAX_UPLOAD_BYTES', async () => {
    const underSizedBuffer = await buildPaddedJpeg(UNDER_LIMIT_SIZE);
    expect(underSizedBuffer.length).toBe(UNDER_LIMIT_SIZE);

    const res = await request(app)
      .post('/join')
      .field('name', 'Under Limit Guest')
      .field('contact', 'limit-under@example.com')
      .field('pin', '2222')
      .attach('avatar', underSizedBuffer, { filename: 'ok.jpg', contentType: 'image/jpeg' });

    // A real, sharp-decodable JPEG under the shared limit must succeed all
    // the way through: signup redirects to "/" and stores the file. If
    // auth.js reverted to a smaller hard-coded limit (e.g. the old 12 MB),
    // this 15 MB-sized buffer would be rejected here and the test would fail.
    expect([301, 302, 303]).toContain(res.status);

    const guest = db
      .prepare('SELECT onboarded, avatar_path FROM guests WHERE contact = ?')
      .get('limit-under@example.com');
    // Issue #564: onboarded starts at the schema default (0) after signup —
    // only GET /how-to-play ever flips it.
    expect(guest.onboarded).toBe(0);
    expect(guest.avatar_path).toMatch(/\.jpg$/);
  });
});
