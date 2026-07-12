// tests/most-liked-badge.test.js
// Issue #484: MOSTLIKED — a transferable badge held by the guest(s) whose
// VISIBLE submissions have collected the most total likes. Covers AC1-AC6
// with exact guest-id/holder-set assertions (not just "a badge exists"),
// following the loadApp()/seed() conventions used by tests/badge-engine.test.js.
//
// All describe blocks below share ONE temp DB (loadApp() runs once in
// beforeAll, same as tests/badge-engine.test.js), so likes accumulate across
// the whole file rather than resetting per test. Assertions therefore only
// ever check containment/non-containment (never "this is the exact holder
// set"), and each scenario's designated leader is given a like total that
// strictly exceeds every total any earlier scenario in this file produced —
// so an earlier guest can never accidentally tie or beat a later scenario's
// intended winner. AC4 (the zero-likes case) is the one exception: it must
// run FIRST, while the shared DB still has no likes at all.
'use strict';

const { loadApp } = require('./helpers/testApp');

let db;
let scoring;
let badges;

let guestTokenSeq = 0;
function makeGuest(token, name) {
  guestTokenSeq += 1;
  // Suffix with a monotonic counter so a retried test never collides with a
  // row its own earlier attempt already inserted under the same literal
  // token — same convention as tests/badge-engine.test.js's makeGuest.
  const uniqueToken = `${token}-${guestTokenSeq}`;
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(uniqueToken, name)
    .lastInsertRowid;
}

let photoSeq = 0;
function submit(guestId, takenDown = 0) {
  photoSeq += 1;
  const photo = `p${photoSeq}.jpg`;
  const thumb = `t${photoSeq}.jpg`;
  // task_id NULL (a memory, issue #247) — MOSTLIKED counts likes on any
  // visible submission, task or memory, so this suite need not thread task
  // ids through every fixture call.
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, NULL, ?, ?, ?)`
    )
    .run(guestId, photo, thumb, takenDown).lastInsertRowid;
}

let likerSeq = 0;
function likeNTimes(submissionId, n) {
  // Every like needs its own guest row — UNIQUE(submission_id, guest_id)
  // means one guest can only like a given photo once — so mint a fresh
  // liker guest per like rather than reusing one.
  for (let i = 0; i < n; i += 1) {
    likerSeq += 1;
    const likerId = makeGuest(`liker-${likerSeq}`, `Liker ${likerSeq}`);
    db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)').run(
      submissionId,
      likerId
    );
  }
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

beforeAll(() => {
  const loaded = loadApp();
  db = loaded.db;
  // Required after loadApp() so it binds to the temp DATA_DIR/DB_PATH.
  scoring = require('../src/services/scoring');
  badges = require('../src/services/badges');
  // Seed the real catalog (AC6) via the actual seed script's logic, mirroring
  // tests/badge-engine.test.js's beforeAll. scripts/seed.js seeds badges and
  // sample tasks only — no guests/submissions/likes — so the DB is still
  // all-zero for AC4 immediately after this runs.
  require('../scripts/seed.js');
});

describe('AC6: seeded catalog contains MOSTLIKED', () => {
  it('MOSTLIKED row is type=transferable with non-empty art_path', () => {
    const row = db.prepare('SELECT * FROM badges WHERE code = ?').get('MOSTLIKED');
    expect(row).toBeTruthy();
    expect(row.type).toBe('transferable');
    expect(row.art_path).toBeTruthy();
  });
});

describe('AC4: zero-likes never holds it', () => {
  // Must run before any other describe block below adds a like — this is
  // the only point in the file where the shared DB truly has zero likes.
  it('no guest holds MOSTLIKED when no guest has any likes on a visible photo', () => {
    expect(badges.TRANSFERABLE_BADGES.MOSTLIKED()).toEqual(new Set());
  });
});

describe('AC1: awarded to the top-liked guest', () => {
  it('guest A holds MOSTLIKED alone when their visible photos have 7 total likes and everyone else has fewer', () => {
    const guestA = makeGuest('ml1-a', 'A');
    const guestB = makeGuest('ml1-b', 'B');

    likeNTimes(submit(guestA), 7);
    likeNTimes(submit(guestB), 3);

    scoring.recomputeTransferableBadges();

    expect(heldCodes(guestA)).toContain('MOSTLIKED');
    expect(heldCodes(guestB)).not.toContain('MOSTLIKED');
  });
});

describe('AC2: steal-able', () => {
  it('B overtakes A and the holder moves', () => {
    const guestA = makeGuest('ml2-a', 'A');
    const guestB = makeGuest('ml2-b', 'B');

    // A's total (8) strictly exceeds every total in the shared DB so far
    // (AC1's 7), so A becomes the sole new leader; B (2) trails both.
    likeNTimes(submit(guestA), 8);
    const photoB = submit(guestB);
    likeNTimes(photoB, 2);

    scoring.recomputeTransferableBadges();
    expect(heldCodes(guestA)).toContain('MOSTLIKED');
    expect(heldCodes(guestB)).not.toContain('MOSTLIKED');

    // B accrues 10 more likes on a second photo (total 2 + 10 = 12),
    // strictly overtaking A's 8. The holder moves from A to B.
    likeNTimes(submit(guestB), 10);

    scoring.recomputeTransferableBadges();
    expect(heldCodes(guestB)).toContain('MOSTLIKED');
    expect(heldCodes(guestA)).not.toContain('MOSTLIKED');
  });
});

describe('AC3: ties held together', () => {
  it('A and B tied for the most total likes both hold MOSTLIKED', () => {
    const guestA = makeGuest('ml3-a', 'A');
    const guestB = makeGuest('ml3-b', 'B');

    // 15 each strictly exceeds the prior high (AC2's 12) and ties A with B.
    likeNTimes(submit(guestA), 15);
    likeNTimes(submit(guestB), 15);

    scoring.recomputeTransferableBadges();

    expect(heldCodes(guestA)).toContain('MOSTLIKED');
    expect(heldCodes(guestB)).toContain('MOSTLIKED');
  });
});

describe('AC5: only visible photos count', () => {
  it("a taken-down photo's likes are excluded from its guest's total", () => {
    const guestA = makeGuest('ml5-a', 'A');
    const guestB = makeGuest('ml5-b', 'B');

    // A's ONLY photo is taken down and carries MORE raw likes (20) than B's
    // visible photo (16) — if the taken_down = 0 filter were missing or
    // wrong, A would incorrectly win. A's counted (visible) total is 0; B's
    // 16 strictly exceeds the prior high (AC3's 15), making B the new leader.
    likeNTimes(submit(guestA, /* takenDown */ 1), 20);
    likeNTimes(submit(guestB), 16);

    scoring.recomputeTransferableBadges();

    expect(heldCodes(guestA)).not.toContain('MOSTLIKED');
    expect(heldCodes(guestB)).toContain('MOSTLIKED');
  });

  it("sums a guest's likes across ALL their visible photos, not just their single most-liked one", () => {
    const guestA = makeGuest('ml5b-a', 'A');
    const guestB = makeGuest('ml5b-b', 'B');

    // A's SUM across two visible photos (9 + 9 = 18) beats B's single
    // photo (17), even though neither of A's individual photos out-likes
    // B's one photo — proving the rule is a per-guest total, not "whoever
    // has the single most-liked photo" (the issue's explicit distinction).
    // 18 strictly exceeds the prior high (AC5's 16).
    likeNTimes(submit(guestA), 9);
    likeNTimes(submit(guestA), 9);
    likeNTimes(submit(guestB), 17);

    scoring.recomputeTransferableBadges();

    expect(heldCodes(guestA)).toContain('MOSTLIKED');
    expect(heldCodes(guestB)).not.toContain('MOSTLIKED');
  });
});
