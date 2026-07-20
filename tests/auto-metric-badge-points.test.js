// tests/auto-metric-badge-points.test.js
// Issue #709: auto (BLOOM/BOUQUET/GARDEN) and metric (COMPLETIONIST) badges
// pay +1 point for as long as a guest holds them, derived on read through
// the existing award-points sum (stmtAwardPointsSum + the leaderboard
// subquery, src/services/scoring.js) — no new scoring term. Covers ACs 1-4.
// Follows the loadApp()/makeGuest/makeTask/submit conventions of
// tests/badge-engine.test.js, but lives in its own file (per the issue's
// implementation plan) because badge-engine.test.js's last describe blocks
// are order-sensitive (they reset the badge catalog and event-seed data).
'use strict';

const { loadApp } = require('./helpers/testApp');

let db;
let scoring;
let photos;

let guestTokenSeq = 0;
function makeGuest(token, name) {
  guestTokenSeq += 1;
  const uniqueToken = `${token}-${guestTokenSeq}`;
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(uniqueToken, name)
    .lastInsertRowid;
}

function makeTask(title) {
  // worth defaults to 1 (tasks CREATE TABLE default), special_mode defaults
  // to 'none' (active) — exactly what these tests need: N active worth-1
  // tasks so a guest's worth sum is simply their completed count.
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

let photoSeq = 0;
function submit(guestId, taskId) {
  photoSeq += 1;
  const photo = `amp-p${photoSeq}.jpg`;
  const thumb = `amp-t${photoSeq}.jpg`;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, photo, thumb).lastInsertRowid;
}

function heldCodes(guestId) {
  return db
    .prepare(
      `SELECT b.code FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
        WHERE gb.guest_id = ? ORDER BY b.code ASC`
    )
    .all(guestId)
    .map((r) => r.code);
}

function leaderboardPointsFor(guestId) {
  const row = scoring.leaderboard().find((r) => r.id === guestId);
  return row ? row.points : undefined;
}

beforeAll(() => {
  const loaded = loadApp();
  db = loaded.db;
  scoring = require('../src/services/scoring');
  photos = require('../src/services/photos');
  // Seed the real catalog so BLOOM/COMPLETIONIST rows exist with the right
  // `type` for both the grant call sites and the db.js backfill's type join.
  require('../scripts/seed.js');
  // scripts/seed.js's own sample tasks would make "5 worth-1 active tasks"
  // ambiguous (COMPLETIONIST would fire early, and worth sums would include
  // tasks these tests never created) — hide them so only this file's own
  // makeTask() calls are active, mirroring badge-engine.test.js's convention.
  db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
});

describe('AC1: BLOOM grant pays +1 (getPoints and leaderboard agree)', () => {
  it('a guest crossing 5 completed tasks gains BLOOM and their total includes the +1', () => {
    const guest = makeGuest('ac1-bloom-guest', 'AC1 Bloom Guest');
    for (let i = 0; i < 5; i += 1) {
      const task = makeTask(`AC1 Task ${i}`);
      submit(guest, task);
    }

    // Before recompute: 5 worth-1 tasks = 5 points, no badge yet.
    expect(scoring.getPoints(guest)).toBe(5);

    scoring.recomputeBadges(guest);

    expect(heldCodes(guest)).toContain('BLOOM');
    // 5 (worth) + 1 (BLOOM's AUTO_METRIC_BADGE_POINTS) = 6.
    expect(scoring.getPoints(guest)).toBe(6);
    expect(leaderboardPointsFor(guest)).toBe(6);
  });
});

describe('AC2: revoking BLOOM on takedown removes the +1 from both totals', () => {
  it('a takedown that drops the guest below 5 completed tasks revokes BLOOM and its point', () => {
    const guest = makeGuest('ac2-takedown-guest', 'AC2 Takedown Guest');
    const submissionIds = [];
    for (let i = 0; i < 5; i += 1) {
      const task = makeTask(`AC2 Task ${i}`);
      submissionIds.push(submit(guest, task));
    }
    scoring.recomputeBadges(guest);
    expect(heldCodes(guest)).toContain('BLOOM');
    expect(scoring.getPoints(guest)).toBe(6); // 5 worth + 1 BLOOM

    // Admin takes down one submission — hideSubmission's shared transaction
    // (src/services/photos.js) recomputes badges as part of the same write,
    // matching how a real takedown reaches this code path.
    photos.hideSubmission(submissionIds[0]);

    expect(heldCodes(guest)).not.toContain('BLOOM');
    // 4 remaining worth-1 submissions, no BLOOM point.
    expect(scoring.getPoints(guest)).toBe(4);
    expect(leaderboardPointsFor(guest)).toBe(4);
  });
});

describe('AC3: transferable and admin-special grants still carry points = 0', () => {
  it('an admin-special grant (awardSpecialBadge) writes points = 0 on its guest_badges row', () => {
    const guest = makeGuest('ac3-special-guest', 'AC3 Special Guest');
    expect(scoring.awardSpecialBadge(guest, 'EARLYBIRD')).toBe(true);

    const row = db
      .prepare(
        `SELECT gb.points FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
          WHERE gb.guest_id = ? AND b.code = 'EARLYBIRD'`
      )
      .get(guest);
    expect(row.points).toBe(0);
  });

  it('a transferable grant (recomputeTransferableBadges) writes points = 0 on its guest_badges row', () => {
    // Register a temporary transferable badge directly against the registry
    // module (mirrors how src/services/badges.js's TRANSFERABLE_BADGES would
    // carry a real one) so recomputeTransferableBadges' grant call site runs
    // for at least one badge — the registry is empty in production since
    // #711 retired MOSTPHOTOS/MOSTLIKED.
    const badgesModule = require('../src/services/badges');
    const guest = makeGuest('ac3-transferable-guest', 'AC3 Transferable Guest');

    const badgeId = db
      .prepare(
        `INSERT INTO badges (code, name, type, art_path, description)
         VALUES ('AC3TRANSFER', 'AC3 Transfer Test', 'transferable', '/badges/x.svg', '')`
      )
      .run().lastInsertRowid;

    badgesModule.TRANSFERABLE_BADGES.AC3TRANSFER = () => new Set([guest]);
    try {
      scoring.recomputeTransferableBadges();
    } finally {
      delete badgesModule.TRANSFERABLE_BADGES.AC3TRANSFER;
    }

    const row = db
      .prepare(`SELECT points FROM guest_badges WHERE guest_id = ? AND badge_id = ?`)
      .get(guest, badgeId);
    expect(row).toBeTruthy();
    expect(row.points).toBe(0);
  });
});

describe('AC4: the db.js backfill fixes a pre-#709 database and nothing else', () => {
  it('backfills exactly a held auto/metric row still at points = 0, leaving a transferable/special row untouched', () => {
    const { ensureAutoMetricBadgePointsBackfilled } = require('../src/db');

    const guest = makeGuest('ac4-backfill-guest', 'AC4 Backfill Guest');

    // Simulate a pre-#709 held BLOOM row: granted the old way, points still 0.
    const bloom = db.prepare(`SELECT id FROM badges WHERE code = 'BLOOM'`).get();
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, 'system', 0)`
    ).run(guest, bloom.id);

    // A same-guest admin-special row at points = 0 — must NOT be touched by
    // the type-joined backfill (the issue's core AC4 requirement: filtering
    // must be by badges.type, not by awarded_by = 'system').
    scoring.awardSpecialBadge(guest, 'SHUTTERBUG');
    const shutterbug = db.prepare(`SELECT id FROM badges WHERE code = 'SHUTTERBUG'`).get();

    const changed = ensureAutoMetricBadgePointsBackfilled();

    const bloomRow = db
      .prepare(`SELECT points FROM guest_badges WHERE guest_id = ? AND badge_id = ?`)
      .get(guest, bloom.id);
    const specialRow = db
      .prepare(`SELECT points FROM guest_badges WHERE guest_id = ? AND badge_id = ?`)
      .get(guest, shutterbug.id);

    expect(bloomRow.points).toBe(1);
    expect(specialRow.points).toBe(0);
    // Exactly the one simulated pre-#709 row above was at points = 0 for an
    // auto/metric badge at this point in the suite (every other grant in
    // this file went through the fixed code path, which already writes
    // points = 1/0 correctly at grant time) — so this call updates exactly 1 row.
    expect(changed).toBe(1);

    // Idempotent: a second run touches nothing further for this guest's rows.
    const secondRun = ensureAutoMetricBadgePointsBackfilled();
    const bloomRowAfter = db
      .prepare(`SELECT points FROM guest_badges WHERE guest_id = ? AND badge_id = ?`)
      .get(guest, bloom.id);
    expect(bloomRowAfter.points).toBe(1);
    expect(secondRun).toBe(0);
  });
});
