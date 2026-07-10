// tests/photos-branches.test.js
// Issue #305 — branch coverage for src/services/photos.js fallback/edge arms
// not exercised by the existing upload/access suites: the URL builders'
// empty-input short-circuit, saveAvatar's empty-buffer guard, hardDelete's
// missing-row and missing-file-field guards, and the cleanup helpers'
// empty/already-removed no-ops.
//
// REQUIRE ORDER: config/db/photos are required only AFTER loadApp() sets
// DATA_DIR/DB_PATH env vars (same pattern as tests/photo-access.test.js).
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let photos;
let config;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  config = require('../config');
  photos = require('../src/services/photos');
});

function insertGuest(name) {
  return db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(`photos-branches-${crypto.randomUUID()}`, name).lastInsertRowid;
}

function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// urlForOriginal / urlForThumb — both arms of the falsy-path short-circuit
// (line 336, line 342).
// ---------------------------------------------------------------------------
describe('urlForOriginal / urlForThumb empty-input arm', () => {
  it("urlForOriginal('') -> '' (falsy short-circuit, not '/uploads/')", () => {
    expect(photos.urlForOriginal('')).toBe('');
  });

  it("urlForOriginal('a.jpg') -> '/uploads/a.jpg' (the built path, inversion guard for the arm above)", () => {
    expect(photos.urlForOriginal('a.jpg')).toBe('/uploads/a.jpg');
  });

  it("urlForThumb('') -> '' (falsy short-circuit, not '/thumbs/')", () => {
    expect(photos.urlForThumb('')).toBe('');
  });

  it("urlForThumb('a.jpg.jpg') -> '/thumbs/a.jpg.jpg'", () => {
    expect(photos.urlForThumb('a.jpg.jpg')).toBe('/thumbs/a.jpg.jpg');
  });
});

// ---------------------------------------------------------------------------
// saveAvatar — empty-buffer guard (line 309).
// ---------------------------------------------------------------------------
describe('saveAvatar empty-buffer guard', () => {
  it('rejects with the empty-buffer message rather than writing a file', async () => {
    const guestId = insertGuest('Empty Avatar Guest');
    await expect(photos.saveAvatar(Buffer.alloc(0), guestId)).rejects.toThrow(/empty buffer/i);
  });

  it('a null buffer is rejected the same way (both halves of the "!buffer || !buffer.length" guard)', async () => {
    const guestId = insertGuest('Null Avatar Guest');
    await expect(photos.saveAvatar(null, guestId)).rejects.toThrow(/empty buffer/i);
  });
});

// ---------------------------------------------------------------------------
// deleteOriginalFile / deleteThumbFile — falsy-path no-op (lines 477, 486)
// and the real unlink-success path (proves the "ignore ENOENT" try/catch
// doesn't accidentally swallow a REAL delete too).
// ---------------------------------------------------------------------------
describe('deleteOriginalFile / deleteThumbFile', () => {
  it("deleteOriginalFile('') and deleteOriginalFile(null) are no-ops (falsy-path short-circuit)", () => {
    expect(() => photos.deleteOriginalFile('')).not.toThrow();
    expect(() => photos.deleteOriginalFile(null)).not.toThrow();
  });

  it("deleteThumbFile('') is a no-op (falsy-path short-circuit)", () => {
    expect(() => photos.deleteThumbFile('')).not.toThrow();
  });

  it('deleteOriginalFile removes a file that really exists on disk', () => {
    const name = 'branches-original-real.jpg';
    const absPath = path.join(config.UPLOADS_DIR, name);
    fs.writeFileSync(absPath, Buffer.from('fake original bytes'));
    expect(fs.existsSync(absPath)).toBe(true);

    photos.deleteOriginalFile(name);

    // Real observable outcome: the file is gone. If deleteOriginalFile were a
    // no-op (the falsy-guard branch wrongly taken for a truthy name), this
    // file would still be on disk.
    expect(fs.existsSync(absPath)).toBe(false);
  });

  it('deleteThumbFile removes a file that really exists on disk', () => {
    const name = 'branches-thumb-real.jpg.jpg';
    const absPath = path.join(config.THUMBS_DIR, name);
    fs.writeFileSync(absPath, Buffer.from('fake thumb bytes'));
    expect(fs.existsSync(absPath)).toBe(true);

    photos.deleteThumbFile(name);
    expect(fs.existsSync(absPath)).toBe(false);
  });

  it('deleting an already-absent file is silently ignored (ENOENT swallowed, not thrown)', () => {
    // Neither file was ever created, so unlinkSync throws ENOENT internally;
    // the function must swallow that specific error.
    expect(() => photos.deleteOriginalFile('never-existed-original.jpg')).not.toThrow();
    expect(() => photos.deleteThumbFile('never-existed-thumb.jpg.jpg')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// hardDelete — missing-row guard (line 438), per-file falsy guards (441/449),
// and the real delete-both-files success path (445/453's unlink calls).
// ---------------------------------------------------------------------------
describe('hardDelete', () => {
  it('returns false for a submission id that does not exist (line 438)', () => {
    expect(photos.hardDelete(999999999)).toBe(false);
  });

  it('deletes both real files and the row, returning true', () => {
    const guestId = insertGuest('HardDelete Guest');
    const taskId = insertTask('HardDelete Task');
    const photoName = 'branches-harddelete-original.jpg';
    const thumbName = 'branches-harddelete-thumb.jpg.jpg';
    const absPhoto = path.join(config.UPLOADS_DIR, photoName);
    const absThumb = path.join(config.THUMBS_DIR, thumbName);
    fs.writeFileSync(absPhoto, Buffer.from('original'));
    fs.writeFileSync(absThumb, Buffer.from('thumb'));

    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(guestId, taskId, photoName, thumbName).lastInsertRowid;

    const result = photos.hardDelete(submissionId);

    expect(result).toBe(true);
    expect(fs.existsSync(absPhoto)).toBe(false);
    expect(fs.existsSync(absThumb)).toBe(false);
    const row = db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId);
    expect(row).toBeUndefined();
  });

  it('a row with photo_path="" (falsy but NOT NULL, per schema) skips the original-file unlink (line 441) but still deletes the thumb and the row', () => {
    // submissions.photo_path is NOT NULL in the schema, so a real NULL row is
    // not constructible here — an empty string is the falsy value the schema
    // actually permits, and it exercises the exact same `if (row.photo_path)`
    // guard at line 441.
    const guestId = insertGuest('HardDelete EmptyPhoto Guest');
    const taskId = insertTask('HardDelete EmptyPhoto Task');
    const thumbName = 'branches-harddelete-emptyphoto-thumb.jpg.jpg';
    const absThumb = path.join(config.THUMBS_DIR, thumbName);
    fs.writeFileSync(absThumb, Buffer.from('thumb only'));

    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, '', ?, 0)`
      )
      .run(guestId, taskId, thumbName).lastInsertRowid;

    // Real assertion this would fail on if the falsy-guard were removed:
    // fs.unlinkSync(absOriginalPath('')) resolves to UPLOADS_DIR itself (a
    // directory), and unlinkSync on a directory throws EISDIR/EPERM (not
    // ENOENT), which the catch block does NOT swallow — so hardDelete would
    // throw instead of returning true if it tried to unlink an empty photo_path.
    let result;
    expect(() => {
      result = photos.hardDelete(submissionId);
    }).not.toThrow();
    expect(result).toBe(true);
    // The thumb (which DOES have a path) was still deleted, and so was the row.
    expect(fs.existsSync(absThumb)).toBe(false);
    const row = db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId);
    expect(row).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// blockTakenDownThumb — the taken-down 404 arm (line 580), via a real request
// through the /thumbs static mount (same pattern as tests/photo-access.test.js,
// scoped to this file's own rows for isolation).
// ---------------------------------------------------------------------------
describe('blockTakenDownThumb taken-down arm (line 580)', () => {
  const request = require('supertest');

  it('a taken-down submission thumbnail 404s through the real /thumbs mount', async () => {
    const guestId = insertGuest('TakenDown Thumb Guest');
    const taskId = insertTask('TakenDown Thumb Task');
    const thumbName = 'a1b2c3d4e5f6a1b2-1719500099999.jpg.jpg'; // matches THUMB_RE
    fs.writeFileSync(path.join(config.THUMBS_DIR, thumbName), Buffer.from('thumb'));

    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 1)`
    ).run(guestId, taskId, 'a1b2c3d4e5f6a1b2-1719500099999.jpg', thumbName);

    const res = await request(app).get('/thumbs/' + thumbName);
    expect(res.status).toBe(404);
  });
});
