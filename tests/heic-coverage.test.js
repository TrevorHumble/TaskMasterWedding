// tests/heic-coverage.test.js
// Issue #281: targeted unit + end-to-end tests for the HEIC branches the #281
// change added that the behavioral suites don't otherwise exercise — the
// heicPixelDimensions ispe-parsing edge arms, safeUploadPath's fail-closed arm,
// the per-guest decode limiter's sliding-window arithmetic, saveAvatar's HEIC
// error arms (pixel-cap passthrough vs generic decode-failure), the short-buffer
// looksLikeHeic guard, and the memory-batch multer-error arm. Real assertions on
// values/behavior, not just "it ran".
//
// REQUIRE ORDER: loadApp() before any require of config/db/photos (see
// tests/helpers/testApp.js).
'use strict';

const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');
const { craftHeicHeader } = require('./helpers/heic-fixtures');

let app;
let db;
let photos;
let rateLimit;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  photos = require('../src/services/photos');
  rateLimit = require('../src/services/rate-limit');
});

// Build a standalone 20-byte ISO-BMFF ispe box declaring width x height.
function ispeBox(width, height, sizeField = 20) {
  const b = Buffer.alloc(20);
  b.writeUInt32BE(sizeField, 0);
  b.write('ispe', 4, 'ascii');
  b.writeUInt32BE(0, 8); // version + flags
  b.writeUInt32BE(width, 12);
  b.writeUInt32BE(height, 16);
  return b;
}

function ftypHeic() {
  const b = Buffer.alloc(16);
  b.writeUInt32BE(16, 0);
  b.write('ftyp', 4, 'ascii');
  b.write('heic', 8, 'ascii');
  b.write('heic', 12, 'ascii');
  return b;
}

describe('heicPixelDimensions ispe-parsing edges', () => {
  it('returns null for a buffer shorter than 20 bytes', () => {
    expect(photos.heicPixelDimensions(Buffer.alloc(10))).toBeNull();
  });

  it('skips an "ispe" whose 4-byte size field is not 20 (not a real ispe box)', () => {
    // Only a mis-sized ispe present -> no valid box -> null.
    const buf = Buffer.concat([ftypHeic(), ispeBox(4000, 3000, 99)]);
    expect(photos.heicPixelDimensions(buf)).toBeNull();
  });

  it('skips an "ispe" marker too near the start or end to be a full box', () => {
    // 'ispe' at offset 0 (t-4 < 0) and 'ispe' near the end (t+16 > length),
    // padded to >= 20 bytes so it passes the length guard.
    const atStart = Buffer.concat([Buffer.from('ispe'), Buffer.alloc(20)]);
    expect(photos.heicPixelDimensions(atStart)).toBeNull();
    const atEnd = Buffer.concat([Buffer.alloc(20), Buffer.from('ispe'), Buffer.from([0, 0, 0])]);
    expect(photos.heicPixelDimensions(atEnd)).toBeNull();
  });

  it('returns the LARGEST-area ispe when several are present (both comparison arms)', () => {
    // second box larger -> best replaced (area > best.area is true)
    const growing = Buffer.concat([ftypHeic(), ispeBox(100, 100), ispeBox(200, 200)]);
    expect(photos.heicPixelDimensions(growing)).toEqual({ width: 200, height: 200 });
    // second box smaller -> best kept (area > best.area is false)
    const shrinking = Buffer.concat([ftypHeic(), ispeBox(200, 200), ispeBox(100, 100)]);
    expect(photos.heicPixelDimensions(shrinking)).toEqual({ width: 200, height: 200 });
  });
});

describe('safeUploadPath', () => {
  it('returns an UPLOADS_DIR path for a real storage-shaped filename', () => {
    const name = 'a1b2c3d4e5f60718-1719500000000.jpg';
    const p = photos.safeUploadPath(name);
    expect(p).not.toBeNull();
    expect(path.basename(p)).toBe(name);
  });

  it('accepts the provisional .heic extension our storage layer can produce', () => {
    expect(photos.safeUploadPath('0011223344556677-1720000000000.heic')).not.toBeNull();
  });

  it('returns null (fail closed) for a non-storage-shaped or traversal name', () => {
    expect(photos.safeUploadPath('../../etc/passwd')).toBeNull();
    expect(photos.safeUploadPath('not-a-real-name.txt')).toBeNull();
    expect(photos.safeUploadPath('')).toBeNull();
    expect(photos.safeUploadPath(null)).toBeNull();
  });
});

describe('recordHeicDecodeAttempt sliding window (deterministic clock)', () => {
  it('allows up to max in a window, denies over it, and recovers after the window', () => {
    const g = 987654; // arbitrary guest id, isolated to this test
    const opts = { max: 2, windowMs: 1000 };

    const a1 = rateLimit.recordHeicDecodeAttempt(g, { ...opts, now: 1000 });
    expect(a1).toEqual({ allowed: true, remaining: 1 });
    const a2 = rateLimit.recordHeicDecodeAttempt(g, { ...opts, now: 1000 });
    expect(a2).toEqual({ allowed: true, remaining: 0 });
    // Third within the window is denied and NOT recorded.
    const a3 = rateLimit.recordHeicDecodeAttempt(g, { ...opts, now: 1000 });
    expect(a3).toEqual({ allowed: false, remaining: 0 });
    // After the window elapses, the earlier attempts prune and it allows again.
    const a4 = rateLimit.recordHeicDecodeAttempt(g, { ...opts, now: 2500 });
    expect(a4.allowed).toBe(true);
  });
});

describe('saveAvatar HEIC error arms', () => {
  function makeGuest() {
    const token = `cov-${crypto.randomUUID()}`;
    return db
      .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
      .run(token, 'Cov Guest').lastInsertRowid;
  }

  it('a short (<12 byte) non-HEIC buffer skips the HEIC path and fails in sharp', async () => {
    // looksLikeHeic returns false via its length guard (buffer.length < 12), so
    // the HEIC branch is skipped and sharp rejects the non-image bytes.
    await expect(photos.saveAvatar(Buffer.from('abc'), makeGuest())).rejects.toBeInstanceOf(Error);
  });

  it('an oversized HEIC avatar surfaces the pixel-cap BAD_IMAGE_TYPE verbatim (guest-safe passthrough)', async () => {
    let thrown;
    try {
      await photos.saveAvatar(craftHeicHeader(16000, 16000), makeGuest());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    expect(thrown.code).toBe('BAD_IMAGE_TYPE');
    expect(thrown.message).toContain('too large');
  });

  it('a valid-header HEIC avatar with no decodable payload gets the generic avatar copy', async () => {
    let thrown;
    try {
      await photos.saveAvatar(craftHeicHeader(100, 100), makeGuest());
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeDefined();
    // Not one of our guest-safe codes -> generic avatar message, no BAD_IMAGE_TYPE.
    expect(thrown.code).toBeUndefined();
    expect(thrown.message).toContain("couldn't be read");
  });
});

describe('memory-batch multer error arm', () => {
  it('a disallowed file type in POST /memories is surfaced as a batch error (no rows)', async () => {
    const token = `cov-mem-${crypto.randomUUID()}`;
    const guestId = db
      .prepare('INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)')
      .run(token, 'Cov Mem').lastInsertRowid;
    const agent = request.agent(app);
    await agent.get('/j/' + token).redirects(1);

    const res = await agent
      .post('/memories')
      .attach('photos', Buffer.from('%PDF-1.4 not an image'), {
        filename: 'doc.pdf',
        contentType: 'application/pdf',
      });

    expect([301, 302, 303]).toContain(res.status);
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ? AND task_id IS NULL')
      .get(guestId);
    expect(rows.n).toBe(0);
  });
});
