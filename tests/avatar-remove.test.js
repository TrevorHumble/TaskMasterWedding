// tests/avatar-remove.test.js
// Issue #528: POST /me/avatar/delete lets a signed-in guest remove their own
// profile photo.
//
// AC1: guest with avatar_path = F -> avatar_path NULL, file F removed from
//      disk, GET /me/edit renders the no-photo placeholder.
// AC2: guest A signed in, POST body attempting to name guest B leaves B's
//      avatar_path unchanged — the route derives the target from the
//      session (res.locals.guest), never from request input.
// AC3 (structural): GET /me/edit shows the remove control only when
//      guest.avatar_path is set.
// AC4 (#409 interplay): removing an avatar that already earned the starter
//      point reverts the starter tile to not-complete but leaves getPoints
//      unchanged (point stays banked); re-uploading sets avatar_path again
//      but does not re-award.
//
// REQUIRE ORDER: config / db / scoring are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH env vars (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

// Realistic stored filename shape (matches photos.js's ORIGINAL_RE allowlist:
// ^[0-9a-f]{16}-\d+\.(jpg|png|webp)$), same pattern as
// tests/guest-delete-avatar.test.js.
const AVATAR_A = 'a1b2c3d4e5f60708-1719500000001.jpg';
const AVATAR_B = 'b2c3d4e5f6070819-1719500000002.jpg';

// A 1x1 red pixel PNG — valid image bytes, no sharp dependency needed to
// produce it (only its bytes are read back by express.static/fs, never
// decoded server-side for a delete).
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

function tinyJpeg(background) {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: background || { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg()
    .toBuffer();
}

let app;
let db;
let scoring;
let uploadsDir;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so scoring's prepared statements and config's
  // paths bind to the temp DATA_DIR/DB_PATH (see testApp.js "REQUIRE ORDER
  // MATTERS").
  scoring = require('../src/services/scoring');
  const config = require('../config');
  uploadsDir = config.UPLOADS_DIR;
});

let guestSeq = 0;
function insertGuest(overrides) {
  guestSeq += 1;
  const g = Object.assign(
    {
      token: 'avatar-remove-guest-' + guestSeq,
      name: 'Test Guest',
      avatar_path: null,
      avatar_point_awarded: 0,
      bonus_points: 0,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO guests (token, name, avatar_path, avatar_point_awarded, bonus_points)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(g.token, g.name, g.avatar_path, g.avatar_point_awarded, g.bonus_points).lastInsertRowid;
}

function guestRow(guestId) {
  return db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
}

// ---------------------------------------------------------------------------
// AC1
// ---------------------------------------------------------------------------
describe('AC1: removal clears the avatar', () => {
  it('deletes the file, nulls avatar_path, and GET /me/edit shows the placeholder afterward', async () => {
    fs.writeFileSync(path.join(uploadsDir, AVATAR_A), TINY_PNG);
    const guestId = insertGuest({ token: 'ac1-guest', avatar_path: AVATAR_A });

    expect(fs.existsSync(path.join(uploadsDir, AVATAR_A))).toBe(true);

    const agent = signInGuest(app, 'ac1-guest');

    // GET /me/edit before the delete: shows the current avatar and the
    // remove control.
    const before = await agent.get('/me/edit');
    expect(before.status).toBe(200);
    expect(before.text).toContain('/uploads/' + AVATAR_A);
    expect(before.text).toContain('Remove photo');

    const res = await agent.post('/me/avatar/delete').type('form').send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/me/edit');

    // DB: avatar_path NULL.
    const row = guestRow(guestId);
    expect(row.avatar_path).toBeNull();

    // Disk: file removed. This is the assertion that would fail if the
    // route stopped calling deleteOriginalFile.
    expect(fs.existsSync(path.join(uploadsDir, AVATAR_A))).toBe(false);

    // GET /me/edit after: no-photo placeholder, no remove control.
    const after = await agent.get('/me/edit');
    expect(after.status).toBe(200);
    expect(after.text).toContain('avatar-placeholder');
    expect(after.text).not.toContain('/uploads/' + AVATAR_A);
    expect(after.text).not.toContain('Remove photo');
  });

  it('is idempotent (safe, no crash) when the guest already has no avatar', async () => {
    insertGuest({ token: 'ac1-no-avatar-guest', avatar_path: null });
    const agent = signInGuest(app, 'ac1-no-avatar-guest');

    const res = await agent.post('/me/avatar/delete').type('form').send({});
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/me/edit');
  });
});

// ---------------------------------------------------------------------------
// AC2 — no cross-guest removal: the target guest comes from the session
// only, never from request input.
// ---------------------------------------------------------------------------
describe('AC2: no cross-guest removal', () => {
  it('guest A POSTing with fields naming guest B leaves B untouched and only removes A own avatar', async () => {
    fs.writeFileSync(path.join(uploadsDir, AVATAR_A), TINY_PNG);
    fs.writeFileSync(path.join(uploadsDir, AVATAR_B), TINY_PNG);

    const guestAId = insertGuest({ token: 'ac2-guest-a', avatar_path: AVATAR_A });
    const guestBId = insertGuest({ token: 'ac2-guest-b', avatar_path: AVATAR_B });

    const agentA = signInGuest(app, 'ac2-guest-a');

    // Attempt to target guest B via every plausible body-field name.
    const res = await agentA
      .post('/me/avatar/delete')
      .type('form')
      .send({ guestId: guestBId, id: guestBId, guest_id: guestBId, token: 'ac2-guest-b' });

    expect(res.status).toBe(302);

    // B is completely unaffected — file and row both intact.
    const rowB = guestRow(guestBId);
    expect(rowB.avatar_path).toBe(AVATAR_B);
    expect(fs.existsSync(path.join(uploadsDir, AVATAR_B))).toBe(true);

    // The route acted on A (the session guest), proving it did something
    // rather than silently no-op-ing the whole request.
    const rowA = guestRow(guestAId);
    expect(rowA.avatar_path).toBeNull();
    expect(fs.existsSync(path.join(uploadsDir, AVATAR_A))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 (structural) — the remove control renders only when there is a photo.
// ---------------------------------------------------------------------------
describe('AC3: control renders only when there is a photo', () => {
  it('no avatar: no remove control', async () => {
    insertGuest({ token: 'ac3-no-avatar' });
    const agent = signInGuest(app, 'ac3-no-avatar');

    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('avatar-remove-form');
    expect(res.text).not.toContain('Remove photo');
    expect(res.text).toContain('avatar-placeholder');
  });

  it('avatar set: remove control is present', async () => {
    fs.writeFileSync(path.join(uploadsDir, AVATAR_A), TINY_PNG);
    insertGuest({ token: 'ac3-with-avatar', avatar_path: AVATAR_A });
    const agent = signInGuest(app, 'ac3-with-avatar');

    const res = await agent.get('/me/edit');
    expect(res.status).toBe(200);
    expect(res.text).toContain('avatar-remove-form');
    expect(res.text).toContain('action="/me/avatar/delete"');
    expect(res.text).toContain('Remove photo');
  });
});

// ---------------------------------------------------------------------------
// AC4 — #409 interplay: removal reverts the starter tile but the banked
// point stays banked; a re-upload does not re-award.
// ---------------------------------------------------------------------------
describe('AC4: #409 starter-task interplay', () => {
  it('reverts the starter tile to not-complete, keeps points unchanged, and a re-upload does not re-award', async () => {
    fs.writeFileSync(path.join(uploadsDir, AVATAR_A), TINY_PNG);
    const guestId = insertGuest({
      token: 'ac4-guest',
      avatar_path: AVATAR_A,
      avatar_point_awarded: 1,
      bonus_points: 1, // the +1 starter point already banked
    });

    const pointsBefore = scoring.getPoints(guestId);
    expect(pointsBefore).toBe(1);

    const agent = signInGuest(app, 'ac4-guest');

    // Before removal: starter tile is complete (in the done list, not the
    // to-do list) — mirrors tests/profile-photo-task.test.js's AC4 pattern.
    const doneBefore = await agent.get('/tasks?view=done');
    expect(doneBefore.text).toContain('Upload your profile photo');
    const todoBefore = await agent.get('/tasks');
    expect(todoBefore.text).not.toContain('Upload your profile photo');

    // Remove the photo.
    const delRes = await agent.post('/me/avatar/delete').type('form').send({});
    expect(delRes.status).toBe(302);

    // Starter tile reverts: now in the to-do list, absent from done.
    const todoAfter = await agent.get('/tasks');
    expect(todoAfter.text).toContain('Upload your profile photo');
    const doneAfter = await agent.get('/tasks?view=done');
    expect(doneAfter.text).not.toContain('Upload your profile photo');

    // The banked point is untouched — removal is not a point clawback.
    const rowAfterDelete = guestRow(guestId);
    expect(rowAfterDelete.avatar_point_awarded).toBe(1); // guard flag still set
    expect(scoring.getPoints(guestId)).toBe(pointsBefore);

    // Re-upload a new avatar via the real POST /me/edit path.
    const jpeg = await tinyJpeg({ r: 5, g: 6, b: 7 });
    const reuploadRes = await agent
      .post('/me/edit')
      .field('name', 'AC4 Guest')
      .attach('avatar', jpeg, { filename: 're-upload.jpg', contentType: 'image/jpeg' });
    expect(reuploadRes.status).toBe(302);

    const rowAfterReupload = guestRow(guestId);
    expect(rowAfterReupload.avatar_path).toBeTruthy(); // avatar_path set again
    expect(rowAfterReupload.avatar_point_awarded).toBe(1); // still just the one guard flip
    // No second award: getPoints reads exactly what it did before removal.
    expect(scoring.getPoints(guestId)).toBe(pointsBefore);
  });
});
