// tests/avatar-badge-threshold.test.js
// Issue #1060: the profile photo now counts toward the BLOOM/BOUQUET/GARDEN
// badge thresholds the same way it already counts toward points and the
// guest home progress bar. scoring.thresholdCompletedCount (visible
// task-linked submissions plus the profile-photo starter, read through
// scoring.starterTaskContribution) is the single owner of "what counts
// toward a threshold"; scoring.recomputeThresholdBadges is the narrow
// threshold-only recompute the two avatar write routes (POST /me/edit,
// POST /me/avatar/delete) call, never the full recomputeBadges (which would
// also run the METRIC_BADGES/COMPLETIONIST pass).
//
// AC1: 4 visible task-linked submissions plus a photo grants BLOOM once
//      badges are recomputed (the photo supplies the fifth completion).
// AC2: POST /me/avatar/delete revokes an already-held threshold badge in the
//      same request, and points drop by the badge's own point plus the
//      starter point.
// AC3: that revocation's recap row carries the photo-reason copy and the
//      /me/edit href, and is a distinct stored kind from a plain
//      badge_revoked row.
// AC4: 5 submissions and no photo still grants BLOOM (the control: this
//      change must not renumber the thresholds).
// AC5: adding a photo via POST /me/edit at 4 submissions grants BLOOM by the
//      time that response returns, not only on the guest's next submission.
// AC6: at a no-live-tasks event with fewer than 5 submissions, neither
//      avatar write grants or revokes COMPLETIONIST, and no
//      notification_events row is recorded for it.
// AC7: getCompletedCount keeps its current meaning (visible task-linked
//      submissions only), unaffected by the profile photo.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// scoring (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so scoring's prepared statements bind to the
  // temp DATA_DIR/DB_PATH (see testApp.js "REQUIRE ORDER MATTERS").
  scoring = require('../src/services/scoring');
});

// A tiny valid JPEG, same pattern as tests/profile-photo-task.test.js, so it
// passes photos.saveAvatar's real sharp pipeline instead of being rejected
// as undecodable.
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

let guestSeq = 0;
function insertGuest(overrides) {
  guestSeq += 1;
  const g = Object.assign(
    {
      token: 'abt-guest-' + guestSeq,
      name: 'Threshold Guest',
      avatar_path: null,
      bonus_points: 0,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO guests (token, name, avatar_path, bonus_points)
       VALUES (?, ?, ?, ?)`
    )
    .run(g.token, g.name, g.avatar_path, g.bonus_points).lastInsertRowid;
}

function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title).lastInsertRowid;
}

function insertSubmission(guestId, taskId) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, 'p.jpg', 't.jpg').lastInsertRowid;
}

// Insert N distinct real tasks, each with one visible submission from
// guestId, so thresholdCompletedCount/getCompletedCount can be driven to an
// exact number without touching the profile-photo starter.
function completeRealTasks(guestId, count) {
  for (let i = 0; i < count; i += 1) {
    const taskId = insertTask(`Real task ${guestSeq}-${i}`);
    insertSubmission(guestId, taskId);
  }
}

function guestRow(guestId) {
  return db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
}

function heldBadgeCodes(guestId) {
  return new Set(
    db
      .prepare(
        `SELECT b.code FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id WHERE gb.guest_id = ?`
      )
      .all(guestId)
      .map((r) => r.code)
  );
}

function badgeIdByCode(code) {
  return db.prepare('SELECT id FROM badges WHERE code = ?').get(code).id;
}

function eventKindsFor(guestId, badgeId) {
  return db
    .prepare('SELECT kind FROM notification_events WHERE guest_id = ? AND badge_id = ?')
    .all(guestId, badgeId)
    .map((r) => r.kind);
}

function totalEventCount(guestId) {
  return db.prepare('SELECT COUNT(*) AS c FROM notification_events WHERE guest_id = ?').get(guestId)
    .c;
}

// ---------------------------------------------------------------------------
// AC1: 4 real submissions plus a photo grants BLOOM (the photo supplies the
// fifth completion).
// ---------------------------------------------------------------------------
describe('AC1: 4 visible submissions plus a photo grants BLOOM', () => {
  it('recomputeThresholdBadges grants BLOOM once thresholdCompletedCount reaches 5 via the photo', () => {
    const guestId = insertGuest({ avatar_path: 'starter-avatar.jpg' });
    completeRealTasks(guestId, 4);

    expect(scoring.getCompletedCount(guestId)).toBe(4);
    expect(scoring.thresholdCompletedCount(guestId)).toBe(5);

    scoring.recomputeThresholdBadges(guestId);

    expect(heldBadgeCodes(guestId).has('BLOOM')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC2: POST /me/avatar/delete revokes an already-held threshold badge in
// the same request; points drop by the badge's own point plus the starter.
// ---------------------------------------------------------------------------
describe('AC2: deleting the photo revokes an already-held threshold badge', () => {
  it('BLOOM is revoked by the time the delete request returns, points drop by 2', async () => {
    const guestId = insertGuest({ token: 'ac2-guest', avatar_path: 'ac2-avatar.jpg' });
    completeRealTasks(guestId, 4);
    scoring.recomputeThresholdBadges(guestId);
    expect(heldBadgeCodes(guestId).has('BLOOM')).toBe(true);

    const pointsBefore = scoring.getPoints(guestId);
    // 4 real tasks (worth 1 each by default) + the badge point + the starter
    // point. The exact base does not matter to this test: only the DROP does.

    const agent = signInGuest(app, 'ac2-guest');
    const res = await agent.post('/me/avatar/delete').type('form').send({});
    expect(res.status).toBe(302);

    expect(guestRow(guestId).avatar_path).toBeNull();
    expect(heldBadgeCodes(guestId).has('BLOOM')).toBe(false);

    // -1 for the badge's own AUTO_METRIC_BADGE_POINTS, -1 for the starter
    // point that leaves with the photo (issue #716, unchanged by this issue).
    expect(scoring.getPoints(guestId)).toBe(pointsBefore - 2);
  });
});

// ---------------------------------------------------------------------------
// AC3: the revocation's recap row carries the photo-reason copy and the
// /me/edit href, and is a distinct stored kind from a plain badge_revoked row.
// ---------------------------------------------------------------------------
describe('AC3: the revocation recap row names the photo, not the generic reason', () => {
  it('stores badge_revoked_photo (not badge_revoked) and renders the AC3 copy/href/dead', async () => {
    const guestId = insertGuest({ token: 'ac3-guest', avatar_path: 'ac3-avatar.jpg' });
    completeRealTasks(guestId, 4);
    scoring.recomputeThresholdBadges(guestId);
    expect(heldBadgeCodes(guestId).has('BLOOM')).toBe(true);

    const agent = signInGuest(app, 'ac3-guest');
    const delRes = await agent.post('/me/avatar/delete').type('form').send({});
    expect(delRes.status).toBe(302);

    const bloomId = badgeIdByCode('BLOOM');
    const kinds = eventKindsFor(guestId, bloomId);
    expect(kinds).toContain('badge_revoked_photo');
    expect(kinds).not.toContain('badge_revoked');

    const recapRes = await agent.get('/recap');
    expect(recapRes.status).toBe(200);
    const row = recapRes.body.rows.find((r) => r.href === '/me/edit' && r.dead === false);
    expect(row).toBeTruthy();
    expect(row.parts[0]).toMatchObject({ text: 'First Bloom', emphasis: true });
    expect(row.parts[1].text).toBe(' left with your profile photo. Add one back to earn it again.');
  });
});

// ---------------------------------------------------------------------------
// AC4: control, 5 real submissions and no photo still grants BLOOM.
// ---------------------------------------------------------------------------
describe('AC4: control, 5 submissions with no photo still grants BLOOM', () => {
  it('grants BLOOM exactly as before, unaffected by this issue', () => {
    const guestId = insertGuest();
    completeRealTasks(guestId, 5);

    expect(scoring.getCompletedCount(guestId)).toBe(5);
    expect(scoring.thresholdCompletedCount(guestId)).toBe(5);

    scoring.recomputeThresholdBadges(guestId);

    expect(heldBadgeCodes(guestId).has('BLOOM')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC5: adding a photo via POST /me/edit at 4 submissions grants BLOOM by
// the time that response returns.
// ---------------------------------------------------------------------------
describe('AC5: uploading a first photo via POST /me/edit crosses BLOOM on that response', () => {
  it('holds BLOOM immediately after the redirect, not only on the next submission', async () => {
    const guestId = insertGuest({ token: 'ac5-guest' });
    completeRealTasks(guestId, 4);
    expect(heldBadgeCodes(guestId).has('BLOOM')).toBe(false);

    const agent = signInGuest(app, 'ac5-guest');
    const jpeg = await tinyJpeg({ r: 9, g: 8, b: 7 });
    const res = await agent
      .post('/me/edit')
      .field('name', 'AC5 Guest')
      .attach('avatar', jpeg, { filename: 'ac5.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);
    expect(guestRow(guestId).avatar_path).toBeTruthy();
    expect(heldBadgeCodes(guestId).has('BLOOM')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6: at a no-live-tasks event with fewer than 5 submissions, neither
// avatar write grants or revokes COMPLETIONIST, and no notification_events
// row is recorded for it. Both routes must never reach the METRIC_BADGES
// pass, which is exactly what recomputeThresholdBadges (as opposed to the
// full recomputeBadges) guarantees.
// ---------------------------------------------------------------------------
describe('AC6: an avatar write never grants or revokes COMPLETIONIST', () => {
  it('adding then removing a photo at a no-live-tasks event leaves COMPLETIONIST untouched, no event row', async () => {
    // This file's other describe blocks insert real tasks into the SAME
    // shared db (one loadApp() per file, not per test): clear them first so
    // this test's "zero live tasks" premise holds regardless of run order,
    // the condition under which isCompletionist (src/services/badges.js)
    // qualifies trivially.
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM tasks').run();

    const guestId = insertGuest({ token: 'ac6-guest' });
    const completionistId = badgeIdByCode('COMPLETIONIST');

    const agent = signInGuest(app, 'ac6-guest');
    const jpeg = await tinyJpeg({ r: 1, g: 1, b: 1 });
    const addRes = await agent
      .post('/me/edit')
      .field('name', 'AC6 Guest')
      .attach('avatar', jpeg, { filename: 'ac6.jpg', contentType: 'image/jpeg' });
    expect(addRes.status).toBe(302);

    expect(heldBadgeCodes(guestId).has('COMPLETIONIST')).toBe(false);
    expect(eventKindsFor(guestId, completionistId)).toEqual([]);
    // AC6 promises "no notification_events row of any kind" on an avatar write
    // at a zero-live-task event, not merely no COMPLETIONIST row: assert the
    // whole-guest count, so a stray grant of any badge would fail this too.
    expect(totalEventCount(guestId)).toBe(0);

    const delRes = await agent.post('/me/avatar/delete').type('form').send({});
    expect(delRes.status).toBe(302);

    expect(heldBadgeCodes(guestId).has('COMPLETIONIST')).toBe(false);
    expect(eventKindsFor(guestId, completionistId)).toEqual([]);
    expect(totalEventCount(guestId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC7: getCompletedCount keeps its current meaning: visible task-linked
// submissions only, unaffected by the profile photo.
// ---------------------------------------------------------------------------
describe('AC7: getCompletedCount is unaffected by the profile photo', () => {
  it('returns the submission-only count whether or not the guest has a photo', () => {
    const withPhoto = insertGuest({ avatar_path: 'ac7-avatar.jpg' });
    completeRealTasks(withPhoto, 3);
    expect(scoring.getCompletedCount(withPhoto)).toBe(3);

    const withoutPhoto = insertGuest();
    completeRealTasks(withoutPhoto, 3);
    expect(scoring.getCompletedCount(withoutPhoto)).toBe(3);

    // Same submission-only figure regardless of avatar_path: only
    // thresholdCompletedCount (not getCompletedCount) differs by the photo.
    expect(scoring.getCompletedCount(withPhoto)).toBe(scoring.getCompletedCount(withoutPhoto));
    expect(scoring.thresholdCompletedCount(withPhoto)).toBe(
      scoring.thresholdCompletedCount(withoutPhoto) + 1
    );
  });
});
