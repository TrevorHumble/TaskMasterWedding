// tests/most-liked-badge.test.js
// Issue #817 (widened by #821): TOPLIKED — a transferable badge, display name
// "Crowd Favorite", whose holder set is every guest owning ANY rank 1-5
// placing in scoring.crowdFavorites() — matching the #788 on-photo crown's
// population exactly, not just the single #1 spot. Covers AC1-AC4:
//
//   AC1 — every top-5 placing owner holds it; a guest who owns no placing
//         photo never does.
//   AC2 — a rank-5 holder's placing photo getting pushed out of the top-5 by
//         a like toggle revokes the badge (unless they hold another placing
//         photo).
//   AC3 — a guest who owns two placing photos at once holds exactly one
//         badge row (no duplicate); losing one placing photo while keeping
//         the other leaves the badge in place.
//   AC4 — the granted guest_badges row carries points = 0, and holding it
//         never changes scoring.getPoints()'s total.
//
// Follows tests/crowd-favorites.test.js's fixture conventions (memory
// submissions to dodge UNIQUE(guest_id, task_id); a fresh distinct guest per
// like, since a guest may like a photo at most once and never their own) and
// tests/badge-engine.test.js's heldCodes() convention for asserting exact
// badge codes.
//
// Issue #894 (below, its own describe block): the flap-replay fix. TOPLIKED
// being transferable means recomputeTransferableBadges() revoke-then-regrants
// a guest's row every time another guest's like nudges them out of and back
// into the top 5 — AC1/AC2/AC4 pin down that a re-grant of a badge already
// announced (a badge_granted event on file for this guest+badge) never
// re-arms render-locals.js's owed-badge celebration, while a badge that
// flapped away before ever being shown genuinely celebrates once it lands
// for good.
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

// Count of stored badge_granted events for one guest's TOPLIKED row, read
// straight off notification_events (same style as
// tests/crowd-favorites.test.js's kindCounts) — the precise thing issue
// #894's AC1/AC2/AC4 promise ("event count is still exactly 1" / "no new
// event") is a row count, not a recap-rendering concern.
function badgeGrantedEventCount(guestId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM notification_events ne
         JOIN badges b ON b.id = ne.badge_id
        WHERE ne.guest_id = ? AND ne.kind = 'badge_granted' AND b.code = 'TOPLIKED'`
    )
    .get(guestId).n;
}

// Same shape as badgeGrantedEventCount, for 'badge_revoked' — AC6's own
// wording ("no change to A's badge_revoked rows relative to current
// behavior") is a row count too: #894 changes nothing about badge_revoked
// emission, so this must read the same after a flap as after a single
// ordinary revoke (PR review finding: nothing in the AC1/AC4 tests pinned
// this down before).
function badgeRevokedEventCount(guestId) {
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM notification_events ne
         JOIN badges b ON b.id = ne.badge_id
        WHERE ne.guest_id = ? AND ne.kind = 'badge_revoked' AND b.code = 'TOPLIKED'`
    )
    .get(guestId).n;
}

// Renders `guest`'s home page through the real app and returns whether the
// #255 celebration dialog for a TOPLIKED grant auto-opened — the same
// `/js/badge-moment.js` script-tag marker tests/recap.test.js's AC1 asserts
// on (header.ejs only emits it when render-locals.js's resolveBadgeMoment
// found something owed). NOT a pure query: exactly like a real page render,
// this STAMPS celebrated_at as a side effect when a badge is owed (the name
// says so on purpose, PR review finding) — calling it twice in a row is
// itself the "does a second render replay it" assertion. Renders through the
// real route per Build rule 6 ("assert the real output value") rather than
// re-deriving stmtOwedBadges' SQL in test code.
async function renderAndTakeBadgeMoment(guest) {
  const agent = signInGuest(app, guest.token);
  const page = await agent.get('/');
  expect(page.status).toBe(200);
  return page.text.includes('/js/badge-moment.js') && page.text.includes('Crowd Favorite!');
}

describe('AC1: every top-5 placing owner holds TOPLIKED; a non-placing guest does not', () => {
  test('six guests, one below the cutoff: the top five hold TOPLIKED, the sixth does not', () => {
    resetField();
    const g1 = makeGuest('Rank1');
    const g2 = makeGuest('Rank2');
    const g3 = makeGuest('Rank3');
    const g4 = makeGuest('Rank4');
    const g5 = makeGuest('Rank5');
    const g6 = makeGuest('Rank6 - misses the cutoff');
    const s1 = makeSubmission(g1.id);
    const s2 = makeSubmission(g2.id);
    const s3 = makeSubmission(g3.id);
    const s4 = makeSubmission(g4.id);
    const s5 = makeSubmission(g5.id);
    const s6 = makeSubmission(g6.id);
    addLikes(s1, 6);
    addLikes(s2, 5);
    addLikes(s3, 4);
    addLikes(s4, 3);
    addLikes(s5, 2);
    addLikes(s6, 1); // rank 6 — never places.

    scoring.recomputeTransferableBadges();

    for (const g of [g1, g2, g3, g4, g5]) {
      expect(heldCodes(g.id)).toContain('TOPLIKED');
    }
    expect(heldCodes(g6.id)).not.toContain('TOPLIKED');
    expect(topLikedHolderIds()).toEqual([g1.id, g2.id, g3.id, g4.id, g5.id].sort((a, b) => a - b));
  });
});

describe('AC2: a rank-5 holder pushed out of the top-5 by a like toggle is revoked', () => {
  test('a new sixth photo overtaking the rank-5 photo revokes TOPLIKED from its owner', async () => {
    resetField();
    const g1 = makeGuest('Rank1');
    const g2 = makeGuest('Rank2');
    const g3 = makeGuest('Rank3');
    const g4 = makeGuest('Rank4');
    const g5 = makeGuest('Rank5, about to drop out');
    const challenger = makeGuest('Challenger');
    const s1 = makeSubmission(g1.id);
    const s2 = makeSubmission(g2.id);
    const s3 = makeSubmission(g3.id);
    const s4 = makeSubmission(g4.id);
    const s5 = makeSubmission(g5.id);
    const sChallenger = makeSubmission(challenger.id);
    addLikes(s1, 6);
    addLikes(s2, 5);
    addLikes(s3, 4);
    addLikes(s4, 3);
    addLikes(s5, 2); // rank 5, holds TOPLIKED.
    addLikes(sChallenger, 1); // rank 6, trailing.

    scoring.recomputeTransferableBadges();
    expect(heldCodes(g5.id)).toContain('TOPLIKED');
    expect(heldCodes(challenger.id)).not.toContain('TOPLIKED');

    // Two likes on the challenger's photo through the real, already-wired
    // /p/:submissionId/like route (src/routes/community.js) push it to 3
    // likes — strictly ahead of g5's 2 — bumping g5 out of the top 5.
    const liker1 = makeGuest('Liker X');
    const agent1 = signInGuest(app, liker1.token);
    await agent1.post(`/p/${sChallenger}/like`).type('form').send({});

    const liker2 = makeGuest('Liker Y');
    const agent2 = signInGuest(app, liker2.token);
    await agent2.post(`/p/${sChallenger}/like`).type('form').send({});

    expect(heldCodes(challenger.id)).toContain('TOPLIKED');
    expect(heldCodes(g5.id)).not.toContain('TOPLIKED');
  });
});

describe('AC3: one badge row per guest regardless of placing-photo count', () => {
  test('a guest owning two placing photos holds exactly one TOPLIKED row; losing one keeps the other', () => {
    resetField();
    const sweep = makeGuest('Sweep Guest, owns two placing photos');
    const filler1 = makeGuest('Filler 1');
    const filler2 = makeGuest('Filler 2');
    const filler3 = makeGuest('Filler 3');
    const sSweep1 = makeSubmission(sweep.id);
    const sSweep2 = makeSubmission(sweep.id);
    const sFiller1 = makeSubmission(filler1.id);
    const sFiller2 = makeSubmission(filler2.id);
    const sFiller3 = makeSubmission(filler3.id);
    addLikes(sSweep1, 6); // rank 1
    addLikes(sSweep2, 5); // rank 2 — same guest, second placing photo.
    addLikes(sFiller1, 4); // rank 3
    addLikes(sFiller2, 3); // rank 4
    addLikes(sFiller3, 2); // rank 5

    scoring.recomputeTransferableBadges();

    // Exactly one guest_badges row for sweep despite two placing photos —
    // the UNIQUE(guest_id, badge_id) constraint this badge relies on.
    const sweepRows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
          WHERE gb.guest_id = ? AND b.code = 'TOPLIKED'`
      )
      .get(sweep.id).n;
    expect(sweepRows).toBe(1);
    expect(heldCodes(sweep.id)).toContain('TOPLIKED');

    // Take down sSweep1 (sweep's rank-1 photo) — sweep still owns sSweep2 at
    // rank 2 (ranks re-tighten but sweep's remaining photo still places), so
    // the badge must remain.
    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(sSweep1);
    scoring.recomputeTransferableBadges();

    expect(heldCodes(sweep.id)).toContain('TOPLIKED');
    const sweepRowsAfter = db
      .prepare(
        `SELECT COUNT(*) AS n FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
          WHERE gb.guest_id = ? AND b.code = 'TOPLIKED'`
      )
      .get(sweep.id).n;
    expect(sweepRowsAfter).toBe(1);
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

    // h also places (rank 2) under the widened rule, and its own grant must
    // likewise add nothing to its total.
    const hPointsBeforeCheck = scoring.getPoints(h.id);
    expect(heldCodes(h.id)).toContain('TOPLIKED');
    expect(scoring.getPoints(h.id)).toBe(hPointsBeforeCheck);

    expect(scoring.getPoints(g.id)).toBe(pointsBeforeGrant);
  });
});

describe('AC5: the TOPLIKED catalog row renders the widened "Crowd Favorite" name', () => {
  test("the seeded catalog row's display name is 'Crowd Favorite' (fed to every badge-display surface)", () => {
    // The profile Badges grid, leaderboard strip, and /badge/TOPLIKED page all
    // render badge.name straight off this DB row through the shared badge-art
    // partial (no per-surface literal), so asserting the row's name here proves
    // the rename reaches all three surfaces. ensureBadgeCatalog() re-syncs this
    // from scripts/badge-catalog.js at load time (already run by loadApp()).
    const badge = db.prepare('SELECT name FROM badges WHERE code = ?').get('TOPLIKED');
    expect(badge.name).toBe('Crowd Favorite');
  });
});

// ---------------------------------------------------------------------------
// Issue #894: a transferable-badge flap (revoke then re-grant, driven by
// another guest's like) must not replay an already-seen celebration, and must
// never silently swallow a celebration the guest hasn't seen yet.
//
// Shared fixture across all three tests below: six guests, g1-g5 placing
// (ranks 1-5) and a trailing challenger at rank 6 — the identical scenario
// AC2's own test above uses, extended with a "push back in" step. g5 sits
// at the boundary (rank 5, 2 likes) so it is the one that flaps.
// ---------------------------------------------------------------------------
function setUpFlapFixture() {
  resetField();
  const g1 = makeGuest('Rank1');
  const g2 = makeGuest('Rank2');
  const g3 = makeGuest('Rank3');
  const g4 = makeGuest('Rank4');
  const g5 = makeGuest('Rank5, about to flap');
  const challenger = makeGuest('Challenger');
  const s1 = makeSubmission(g1.id);
  const s2 = makeSubmission(g2.id);
  const s3 = makeSubmission(g3.id);
  const s4 = makeSubmission(g4.id);
  const s5 = makeSubmission(g5.id);
  const sChallenger = makeSubmission(challenger.id);
  addLikes(s1, 6);
  addLikes(s2, 5);
  addLikes(s3, 4);
  addLikes(s4, 3);
  addLikes(s5, 2); // rank 5 — the guest about to flap.
  addLikes(sChallenger, 1); // rank 6, trailing.
  return { g5, s5, sChallenger };
}

// Pushes g5 out of the top 5: two more likes make the challenger's photo
// strictly ahead of g5's 2, and strictly its own distinct rank (4, tied only
// with g4) rather than tying g5 back in — see the per-test comments below for
// why this specific delta keeps the "out" state unambiguous.
function flapOut(sChallenger) {
  addLikes(sChallenger, 2);
  scoring.recomputeTransferableBadges();
}

// Pushes g5 back into the top 5 with the smallest possible nudge (one like):
// g5's count now ties the rank-4 tier (g4/challenger) rather than needing to
// beat it outright — crowdFavorites()'s own documented rule (src/services/
// scoring.js, "a big top tie can still place more than 5") means this tie
// widens the placing set to include everyone at that tier, g5 included;
// that widening is correct, pre-existing #625/#821 behavior, not something
// this test needs to avoid.
function flapBackIn(s5) {
  addLikes(s5, 1);
  scoring.recomputeTransferableBadges();
}

describe('AC1 (#894): a flap after the celebration was shown does not re-arm it', () => {
  test('event count stays 1 and the restored row is already-celebrated', async () => {
    const { g5, s5, sChallenger } = setUpFlapFixture();
    scoring.recomputeTransferableBadges();
    expect(heldCodes(g5.id)).toContain('TOPLIKED');

    // g5 renders once: the celebration is shown and stamped, exactly like
    // AC3 of issue #644's own recap.test.js suite.
    expect(await renderAndTakeBadgeMoment(g5)).toBe(true);
    expect(badgeGrantedEventCount(g5.id)).toBe(1);
    expect(topLikedRow(g5.id).celebrated_at).not.toBeNull();

    flapOut(sChallenger);
    expect(heldCodes(g5.id)).not.toContain('TOPLIKED');
    // AC6: the flap-out's own badge_revoked emission is unchanged by #894 —
    // exactly one, same as an ordinary revoke would leave.
    expect(badgeRevokedEventCount(g5.id)).toBe(1);
    flapBackIn(s5);
    expect(heldCodes(g5.id)).toContain('TOPLIKED');
    // The re-grant does not touch badge_revoked at all — still 1.
    expect(badgeRevokedEventCount(g5.id)).toBe(1);

    // The rule this issue sets: no owed moment, event count still exactly 1,
    // and the restored row carries celebrated_at already set — a re-grant of
    // an already-announced badge is silent.
    expect(await renderAndTakeBadgeMoment(g5)).toBe(false);
    expect(badgeGrantedEventCount(g5.id)).toBe(1);
    expect(topLikedRow(g5.id).celebrated_at).not.toBeNull();
  });
});

describe('AC2 (#894): a flap that completes before the guest ever renders still celebrates exactly once', () => {
  test('the never-celebrated grant event is retracted and reissued, not duplicated', async () => {
    const { g5, s5, sChallenger } = setUpFlapFixture();
    scoring.recomputeTransferableBadges();
    expect(heldCodes(g5.id)).toContain('TOPLIKED');
    expect(badgeGrantedEventCount(g5.id)).toBe(1);
    // Not yet rendered — the row is still owed.
    expect(topLikedRow(g5.id).celebrated_at).toBeNull();

    // The whole flap (out and back in) happens before g5 ever renders a page.
    flapOut(sChallenger);
    expect(heldCodes(g5.id)).not.toContain('TOPLIKED');
    flapBackIn(s5);
    expect(heldCodes(g5.id)).toContain('TOPLIKED');

    // A never-celebrated grant that un-happens is fully retracted (this
    // issue's second rule): the revoke deleted the first badge_granted event,
    // so the re-grant wrote a genuine new one — still exactly 1 on file, and
    // the row is still owed, not already-celebrated.
    expect(badgeGrantedEventCount(g5.id)).toBe(1);
    expect(topLikedRow(g5.id).celebrated_at).toBeNull();

    // First render: celebrates exactly once.
    expect(await renderAndTakeBadgeMoment(g5)).toBe(true);
    expect(topLikedRow(g5.id).celebrated_at).not.toBeNull();
    expect(badgeGrantedEventCount(g5.id)).toBe(1);

    // A second render must not reopen it.
    expect(await renderAndTakeBadgeMoment(g5)).toBe(false);
  });
});

describe('AC4 (#894): re-earning a celebrated-then-revoked badge restores it already-celebrated', () => {
  test('a guest who genuinely drops out and later re-places gets no second celebration or event', async () => {
    const { g5, s5, sChallenger } = setUpFlapFixture();
    scoring.recomputeTransferableBadges();
    expect(await renderAndTakeBadgeMoment(g5)).toBe(true);
    expect(topLikedRow(g5.id).celebrated_at).not.toBeNull();
    expect(badgeGrantedEventCount(g5.id)).toBe(1);

    // g5 drops out and STAYS out across more than one recompute pass — a
    // genuine revoke, not a same-tick flap (recomputeTransferableBadges is
    // idempotent, so re-running it while nothing changed must not touch the
    // already-revoked row or emit a second badge_revoked).
    flapOut(sChallenger);
    expect(heldCodes(g5.id)).not.toContain('TOPLIKED');
    expect(badgeRevokedEventCount(g5.id)).toBe(1);
    scoring.recomputeTransferableBadges();
    expect(heldCodes(g5.id)).not.toContain('TOPLIKED');
    // Idempotent re-run over an unchanged holder set must not emit a second
    // badge_revoked for a guest who was already out.
    expect(badgeRevokedEventCount(g5.id)).toBe(1);

    // Later, g5 genuinely re-earns a placing photo.
    flapBackIn(s5);
    expect(heldCodes(g5.id)).toContain('TOPLIKED');

    // Restored already-celebrated, no new badge_granted event — the standing
    // news this re-grant carries is #895's crowd_favorite entry event on the
    // like-driven path instead (out of scope here, AC4's own wording).
    expect(topLikedRow(g5.id).celebrated_at).not.toBeNull();
    expect(badgeGrantedEventCount(g5.id)).toBe(1);
    expect(await renderAndTakeBadgeMoment(g5)).toBe(false);
  });
});
