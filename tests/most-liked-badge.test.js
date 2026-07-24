// tests/most-liked-badge.test.js
// Issue #817: TOPLIKED — a transferable badge whose holder set is every guest
// owning a rank === 1 placing in scoring.crowdFavorites(). Covers AC1-AC4:
//
//   AC1 — the strict leader holds TOPLIKED; a lesser guest never does.
//   AC2 — a like that overtakes the leader, fired through the real
//         like-toggle route (already wired, no new route added by this
//         issue), transfers TOPLIKED to the new leader and revokes it from
//         the old one.
//   AC3 — a rank-1 tie grants TOPLIKED to every tied co-leader, not just one.
//   AC4 — the granted guest_badges row carries points = 0, and holding it
//         never changes scoring.getPoints()'s total.
//
// Follows tests/crowd-favorites.test.js's fixture conventions (memory
// submissions to dodge UNIQUE(guest_id, task_id); a fresh distinct guest per
// like, since a guest may like a photo at most once and never their own) and
// tests/badge-engine.test.js's heldCodes() convention for asserting exact
// badge codes.
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  scoring = require('../src/services/scoring');
});

// Clears guests and tasks (which cascades away submissions/likes/comments/
// guest_badges/notification_events via guests.id ON DELETE CASCADE) between
// tests. Deliberately does NOT delete `badges` — the TOPLIKED catalog row is
// seeded once by src/db.js's own ensureBadgeCatalog() at module load time
// (loadApp() triggers this the moment it requires src/app.js/src/db.js), and
// scoring.recomputeTransferableBadges() needs that catalog row present to
// find TOPLIKED in its registry walk at all.
function resetField() {
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
}

let seq = 0;

/** A guest with no submissions yet. @returns {{id: number, token: string}} */
function makeGuest(name) {
  seq += 1;
  const token = `topliked-token-${seq}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  return { id, token };
}

/**
 * One visible MEMORY submission (task_id NULL) — same convention
 * tests/crowd-favorites.test.js uses, both to compete under the settled
 * "memories compete" rule and to dodge UNIQUE(guest_id, task_id).
 * @param {number} guestId
 * @returns {number} the new submission's id.
 */
function makeSubmission(guestId) {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, NULL, ?, ?, 0)`
    )
    .run(guestId, `p${seq}.jpg`, `t${seq}.jpg`).lastInsertRowid;
}

/** `count` likes on `submissionId`, each from a freshly-minted distinct guest. */
function addLikes(submissionId, count) {
  for (let i = 0; i < count; i++) {
    const liker = makeGuest(`Liker ${seq}`);
    db.prepare(`INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
      submissionId,
      liker.id
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

function topLikedHolderIds() {
  return db
    .prepare(
      `SELECT gb.guest_id FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
        WHERE b.code = 'TOPLIKED' ORDER BY gb.guest_id ASC`
    )
    .all()
    .map((r) => r.guest_id);
}

function topLikedRow(guestId) {
  return db
    .prepare(
      `SELECT gb.* FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
        WHERE gb.guest_id = ? AND b.code = 'TOPLIKED'`
    )
    .get(guestId);
}

describe('AC1: the strict leader holds TOPLIKED, no other guest does', () => {
  test('a guest with strictly the most likes holds TOPLIKED; a lesser guest does not', () => {
    resetField();
    const g = makeGuest('G');
    const h = makeGuest('H');
    const subG = makeSubmission(g.id);
    const subH = makeSubmission(h.id);
    addLikes(subG, 5);
    addLikes(subH, 2);

    scoring.recomputeTransferableBadges();

    expect(heldCodes(g.id)).toContain('TOPLIKED');
    expect(heldCodes(h.id)).not.toContain('TOPLIKED');
    // Exactly one holder — the badge does not fan out to anyone but the
    // strict leader.
    expect(topLikedHolderIds()).toEqual([g.id]);
  });
});

describe('AC2: a like that overtakes the leader transfers TOPLIKED', () => {
  test('H overtaking G through the real like-toggle route moves TOPLIKED from G to H', async () => {
    resetField();
    const g = makeGuest('G');
    const h = makeGuest('H');
    const subG = makeSubmission(g.id);
    const subH = makeSubmission(h.id);

    addLikes(subG, 5); // G leads at 5.
    addLikes(subH, 4); // H trails at 4.

    scoring.recomputeTransferableBadges();
    expect(heldCodes(g.id)).toContain('TOPLIKED');
    expect(heldCodes(h.id)).not.toContain('TOPLIKED');

    // Two more likes on H's photo, POSTed through the real, already-wired
    // /p/:submissionId/like route (src/routes/community.js) — not a direct
    // recompute call — proves the existing trigger point, not a new one,
    // performs the transfer (this issue adds no route). 4 -> 5 (tie,
    // intermediate) -> 6 (strictly exceeds G's 5).
    const liker1 = makeGuest('Liker X');
    const agent1 = signInGuest(app, liker1.token);
    await agent1.post(`/p/${subH}/like`).type('form').send({});

    const liker2 = makeGuest('Liker Y');
    const agent2 = signInGuest(app, liker2.token);
    await agent2.post(`/p/${subH}/like`).type('form').send({});

    expect(heldCodes(h.id)).toContain('TOPLIKED');
    expect(heldCodes(g.id)).not.toContain('TOPLIKED');
    expect(topLikedHolderIds()).toEqual([h.id]);
  });
});

describe('AC3: a rank-1 tie grants TOPLIKED to every tied co-leader', () => {
  test('two guests tied for the most likes both hold TOPLIKED; a lower-ranked guest does not', () => {
    resetField();
    const g = makeGuest('G');
    const h = makeGuest('H');
    const other = makeGuest('Other');
    const subG = makeSubmission(g.id);
    const subH = makeSubmission(h.id);
    const subOther = makeSubmission(other.id);
    addLikes(subG, 5);
    addLikes(subH, 5);
    addLikes(subOther, 2);

    scoring.recomputeTransferableBadges();

    expect(heldCodes(g.id)).toContain('TOPLIKED');
    expect(heldCodes(h.id)).toContain('TOPLIKED');
    expect(heldCodes(other.id)).not.toContain('TOPLIKED');
    expect(topLikedHolderIds()).toEqual([g.id, h.id].sort((a, b) => a - b));
  });
});

describe('AC4: TOPLIKED is display-only — points = 0, getPoints() unaffected', () => {
  test('the granted guest_badges row carries points = 0, and holding TOPLIKED does not change the leader total', () => {
    resetField();
    const g = makeGuest('G');
    const h = makeGuest('H');
    const subG = makeSubmission(g.id);
    const subH = makeSubmission(h.id);
    addLikes(subG, 5); // rank 1 -> 5 crowd points, already counted by getPoints
    addLikes(subH, 2); // rank 2 -> 4 crowd points

    // getPoints already includes G's crowd-favorite rank-1 points BEFORE
    // TOPLIKED is ever granted (crowdPointsByGuest reads crowdFavorites()
    // directly, independent of any guest_badges row) — captured here so the
    // assertion below proves the grant itself adds nothing further.
    const pointsBeforeGrant = scoring.getPoints(g.id);
    expect(heldCodes(g.id)).not.toContain('TOPLIKED');

    scoring.recomputeTransferableBadges();

    const row = topLikedRow(g.id);
    expect(row).toBeTruthy();
    expect(row.points).toBe(0);

    expect(scoring.getPoints(g.id)).toBe(pointsBeforeGrant);
  });
});
