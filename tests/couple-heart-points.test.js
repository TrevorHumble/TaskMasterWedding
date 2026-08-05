// tests/couple-heart-points.test.js
// Issue #1107: the couple's heart pays 1 point per like from a couple-flagged
// guest (guests.is_couple = 1), uncapped across likes and photos, fully
// derived. Reverses #647's original "pays nothing" settlement (the
// 2026-07-19 stickiness consult, docs/stickiness-consult-2026-07-19.md, N4);
// the owner reversed that on 2026-08-04 in the point-system rebalance
// session. tests/couple-heart.test.js covers the render surfaces (mark,
// tally, dialog, recap row): this file covers the point arithmetic only.
//
//   AC1: a couple-like pays its owner 1 point; an un-like removes it on the
//        very next read with no stored bookkeeping; likes from either
//        couple member, across any number of photos, all add, uncapped; an
//        ordinary (non-couple) like contributes nothing to this term.
//   AC2: leaderboard()'s row.points folds in the identical
//        couplePointsByGuest() total getPoints reads, so the two readers
//        never disagree.
//   AC3: a takedown of a couple-liked photo drops its couple-like points;
//        a restore brings them back.
//   AC4: photoPoints (the stable per-photo figure) never moves when a
//        couple like lands: the term stays out of it, the same standing
//        rationale as the crowd-favorite exclusion (points.js's own doc
//        comment).
//
// Every like in this file is also a crowd-favorite VOTE (issue #625 does not
// care who casts a like), so a fixture's own liked photo would otherwise
// become the sole crowd favorite in this file's empty test database and pull
// in an unrelated +5. seedCrowdFavoriteNoise() below plants five OTHER
// guests' photos tied at 4 likes apiece, filling every one of the five
// crowd-favorite paying ranks, so every fixture in this file (which never
// exceeds 3 likes on its own photo) reliably never places, and getPoints()
// readings stay exactly the terms each test is naming, nothing borrowed from
// #625.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let photos;
let feed;
let MEMORY_DAILY_PAYING_CAP;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  scoring = require('../src/services/scoring');
  photos = require('../src/services/photos');
  // slideshowSequence() is the real per-photo ranking surface the MAJOR
  // review finding's guard test below exercises (AC4).
  feed = require('../src/services/feed');
  // Not exported by the scoring facade (src/services/scoring.js), read
  // straight from its owning module, the same way tests/crowd-favorites.test.js
  // does, so this file's memory-day expectation is derived from the same
  // constant points.js enforces, never re-typed as a bare 2.
  MEMORY_DAILY_PAYING_CAP = require('../src/services/scoring/points').MEMORY_DAILY_PAYING_CAP;
});

// guests.id cascades to submissions/likes (ON DELETE CASCADE, src/db.js), so
// deleting guests alone clears both tables each test seeds; tasks do not
// cascade from guests and are cleared separately. badges is cleared too
// (the same three-table reset tests/crowd-favorites.test.js uses): with the
// badges CATALOG empty, a takedown's recompute has no COMPLETIONIST
// definition to vacuously grant a guest with zero active tasks (0 of 0
// "completed"), which would otherwise pollute this file's getPoints()
// readings with an unrelated +3.
function resetField() {
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM badges').run();
}

let seq = 0;

/** A guest with no submissions yet. @returns {{id: number, token: string}} */
function makeGuest(name, opts = {}) {
  seq += 1;
  const token = `couple-pts-${seq}`;
  const id = db
    .prepare('INSERT INTO guests (token, name, is_couple) VALUES (?, ?, ?)')
    .run(token, name, opts.isCouple ? 1 : 0).lastInsertRowid;
  return { id, token };
}

/**
 * One visible MEMORY submission (task_id NULL, so no task-worth term to
 * account for), pays its owner +1 via the memory-day term (points.js's
 * memoryPoints, first two memories of the event-local day) the moment it
 * exists, independent of any like.
 */
function makeSubmission(guestId) {
  seq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, NULL, ?, ?, 0)`
    )
    .run(guestId, `cp${seq}.jpg`, `cp${seq}t.jpg`).lastInsertRowid;
}

function like(submissionId, likerGuestId) {
  db.prepare('INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)').run(
    submissionId,
    likerGuestId
  );
}

function unlike(submissionId, likerGuestId) {
  db.prepare('DELETE FROM likes WHERE submission_id = ? AND guest_id = ?').run(
    submissionId,
    likerGuestId
  );
}

/**
 * Read the rendered .points-count figure for ONE submission's feed card,
 * scoped to that card's own <article> chunk so other photos' counts in the
 * same response can never bleed in. Same pattern as
 * tests/per-photo-points.test.js's pointsInFeedBody.
 */
function pointsInFeedBody(body, submissionId) {
  const marker = 'id="photo-' + submissionId + '"';
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = body.indexOf('<article', start + marker.length);
  const chunk = body.slice(start, nextArticle === -1 ? body.length : nextArticle);
  const match = chunk.match(/<span class="points-count">(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Five distinct filler guests' memories, each liked by the same four filler
 * likers (4 likes apiece, tied): a 5-way tie that occupies every one of the
 * five crowd-favorite paying ranks (CROWD_FAVORITE_POINTS.length = 5). Any
 * OTHER photo in the same database with fewer than 4 likes (every fixture
 * below tops out at 3) ranks 6th or worse and never places, keeping this
 * file's getPoints() readings free of crowd-favorite noise. See this file's
 * header comment for why that noise would otherwise appear at all.
 */
function seedCrowdFavoriteNoise() {
  const fillerLikers = [];
  for (let i = 0; i < 4; i++) {
    fillerLikers.push(makeGuest(`Filler Liker ${i}`));
  }
  for (let i = 0; i < 5; i++) {
    const fillerOwner = makeGuest(`Filler Owner ${i}`);
    const fillerSubmission = makeSubmission(fillerOwner.id);
    for (const liker of fillerLikers) {
      like(fillerSubmission, liker.id);
    }
  }
}

describe('AC1: a couple-like pays 1 point, uncapped, an un-like removes it', () => {
  test('one couple-like pays the owner 1 point on top of the memory-day baseline', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const owner = makeGuest('AC1 Owner');
    const couple = makeGuest('Lilly', { isCouple: true });
    const submissionId = makeSubmission(owner.id);

    // Baseline before any like: just the memory-day term (+1), the memory
    // submission itself, no couple points yet.
    expect(scoring.getPoints(owner.id)).toBe(1);
    like(submissionId, couple.id);
    expect(scoring.getPoints(owner.id)).toBe(2);
    expect(scoring.couplePointsByGuest().get(owner.id)).toBe(1);
  });

  test('un-liking removes the point on the very next read, with no stored bookkeeping', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const owner = makeGuest('AC1b Owner');
    const couple = makeGuest('Axel', { isCouple: true });
    const submissionId = makeSubmission(owner.id);

    like(submissionId, couple.id);
    expect(scoring.getPoints(owner.id)).toBe(2); // memory(1) + couple(1)

    unlike(submissionId, couple.id);
    expect(scoring.getPoints(owner.id)).toBe(1); // memory(1) only
    expect(scoring.couplePointsByGuest().has(owner.id)).toBe(false);
  });

  test('likes from both couple members, across two photos, add uncapped', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const owner = makeGuest('AC1c Owner');
    const lilly = makeGuest('Lilly', { isCouple: true });
    const axel = makeGuest('Axel', { isCouple: true });
    const photoA = makeSubmission(owner.id);
    const photoB = makeSubmission(owner.id);

    like(photoA, lilly.id);
    like(photoA, axel.id);
    like(photoB, lilly.id);

    // 3 couple likes total across 2 photos: no per-photo or per-liker cap.
    expect(scoring.couplePointsByGuest().get(owner.id)).toBe(3);
    // Both memories land on the same event-local day, so the memory-day term
    // pays min(MEMORY_DAILY_PAYING_CAP, 2) on top, every other term is 0.
    expect(scoring.getPoints(owner.id)).toBe(3 + Math.min(MEMORY_DAILY_PAYING_CAP, 2));
  });

  test('an ordinary (non-couple) like contributes nothing to this term', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const owner = makeGuest('AC1d Owner');
    const ordinary = makeGuest('AC1d Ordinary');
    const submissionId = makeSubmission(owner.id);

    const before = scoring.getPoints(owner.id); // memory(1) only
    like(submissionId, ordinary.id);
    expect(scoring.getPoints(owner.id)).toBe(before); // unchanged, ordinary like pays nothing here
    expect(scoring.couplePointsByGuest().has(owner.id)).toBe(false);
  });
});

describe('AC2: leaderboard() folds in the identical couplePointsByGuest() total getPoints reads', () => {
  test('a couple-liked author and an ordinary-liked author agree between readers, and differ from each other by exactly 1', () => {
    resetField();
    const coupleAuthor = makeGuest('AC2 Couple Author');
    const ordinaryAuthor = makeGuest('AC2 Ordinary Author');
    const couple = makeGuest('Lilly', { isCouple: true });
    const ordinary = makeGuest('AC2 Ordinary Liker');
    const coupleSubmission = makeSubmission(coupleAuthor.id);
    const ordinarySubmission = makeSubmission(ordinaryAuthor.id);

    like(coupleSubmission, couple.id);
    like(ordinarySubmission, ordinary.id);

    const board = scoring.leaderboard();
    const boardById = new Map(board.map((r) => [r.id, r]));

    // No noise-suppression needed here: both photos carry exactly one like
    // each, so they tie for crowd-favorite rank 1 and each collects the same
    // +5, it cancels out of the +1 difference below regardless, and both
    // readers (getPoints, leaderboard) are asserted to agree on whatever the
    // real total is.
    expect(boardById.get(coupleAuthor.id).points).toBe(scoring.getPoints(coupleAuthor.id));
    expect(boardById.get(ordinaryAuthor.id).points).toBe(scoring.getPoints(ordinaryAuthor.id));
    expect(boardById.get(coupleAuthor.id).points).toBe(boardById.get(ordinaryAuthor.id).points + 1);
  });
});

describe("AC3: a takedown drops a couple-liked photo's points; a restore brings them back", () => {
  test('takedown removes both the memory-day and couple-heart points on this photo; restore returns both', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const owner = makeGuest('AC3 Owner');
    const couple = makeGuest('Lilly', { isCouple: true });
    const submissionId = makeSubmission(owner.id);

    expect(scoring.getPoints(owner.id)).toBe(1); // memory(1), no like yet
    like(submissionId, couple.id);
    expect(scoring.getPoints(owner.id)).toBe(2); // memory(1) + couple(1)

    // The photo itself goes invisible: VISIBLE_WHERE drops it from BOTH the
    // memory-day term and the couple-heart term at once, not couple-heart
    // alone.
    photos.hideSubmission(submissionId);
    expect(scoring.getPoints(owner.id)).toBe(0);
    expect(scoring.couplePointsByGuest().has(owner.id)).toBe(false);

    photos.restoreSubmission(submissionId);
    expect(scoring.getPoints(owner.id)).toBe(2);
    expect(scoring.couplePointsByGuest().get(owner.id)).toBe(1);
  });
});

describe('AC4: photoPoints (the stable per-photo figure) never moves when a couple like lands', () => {
  test('photoPoints stays worth + photoBonus + bonusAmount before and after a couple like, even as getPoints moves', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const owner = makeGuest('AC4 Owner');
    const couple = makeGuest('Lilly', { isCouple: true });
    const taskId = db
      .prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)')
      .run('AC4 Task', 4).lastInsertRowid;
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
         VALUES (?, ?, ?, ?, 0, 2)`
      )
      .run(owner.id, taskId, 'ac4.jpg', 'ac4t.jpg').lastInsertRowid;

    const before = scoring.photoPoints(2, 4, 0);
    expect(before).toBe(6);
    expect(scoring.getPoints(owner.id)).toBe(6); // task-linked, no memory-day term here

    like(submissionId, couple.id);

    // photoPoints takes its inputs directly (worth, photoBonus, bonusAmount),
    // none of which a couple like ever writes to, so the figure this
    // function returns is byte-identical before and after, even though
    // getPoints' AGGREGATE total for this same guest just moved by 1 (the
    // couple-heart term getPoints/leaderboard fold in on top, which
    // photoPoints deliberately never does, points.js's doc comment).
    const after = scoring.photoPoints(2, 4, 0);
    expect(after).toBe(before);
    expect(scoring.getPoints(owner.id)).toBe(7);
  });

  // MAJOR (PR review, #1107): the assertion above is tautological, both
  // sides call scoring.photoPoints(2, 4, 0) with the same literal arguments,
  // so it cannot fail under any implementation. This test instead reads the
  // real render surface AC4 is about: feed.slideshowSequence()'s per-task
  // ranking, which is built directly from row.points (feed.js), the same
  // field a wrongly-widened photoPoints call would corrupt. Two same-task
  // photos are set up perfectly tied on points (equal worth, no bonus) and
  // on like_count (one like apiece), so nothing except row.points can decide
  // which one slideshowSequence ranks first; a couple-like then lands on the
  // OLDER photo. Correctly, the NEWER photo still wins the tie (a stable
  // sort keeps the newest-first base order when nothing else distinguishes
  // the two). If a future change folds couplePointsByGuest() into feed.js's
  // row.points (the exact violation the PR review's mutation test applied at
  // feed.js's photoPoints assignment line), the older, couple-liked photo
  // would gain a point nothing else here explains and flip the ranking, and
  // this assertion would fail.
  test('the real ranking surface (slideshowSequence) never moves for a tied pair when only a couple-like lands', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const taskId = db
      .prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)')
      .run('AC4 Regression Task', 4).lastInsertRowid;
    const ownerB = makeGuest('AC4 Regression Owner B');
    const ownerA = makeGuest('AC4 Regression Owner A');
    const couple = makeGuest('Lilly', { isCouple: true });
    const ordinary = makeGuest('AC4 Regression Ordinary');

    // B is inserted first (older), A second (newer): same task, same worth,
    // no bonus, so photoPoints ties at 4 apiece for both, with nothing here
    // to break that tie except insertion order.
    const submissionB = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
         VALUES (?, ?, ?, ?, 0, 0)`
      )
      .run(ownerB.id, taskId, 'ac4reg-b.jpg', 'ac4reg-bt.jpg').lastInsertRowid;
    const submissionA = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
         VALUES (?, ?, ?, ?, 0, 0)`
      )
      .run(ownerA.id, taskId, 'ac4reg-a.jpg', 'ac4reg-at.jpg').lastInsertRowid;

    // Equal like_count on both (1 apiece), so the like_count tiebreak below
    // the points comparison can never explain a flip on its own: only a
    // couple-like's points (photoPoints itself never reads likes at all)
    // could move it.
    like(submissionA, ordinary.id);
    like(submissionB, couple.id);

    const sequence = feed.slideshowSequence();
    const winner = sequence.find(
      (item) => item.type === 'photo' && item.task_title === 'AC4 Regression Task' && item.winner
    );

    expect(winner.guest_name).toBe('AC4 Regression Owner A');
  });

  // The other render surface AC4 names: the feed card's own printed number
  // (community.js's attachPhotoPoints, printed by feed.ejs's .points-count
  // span). A separate code path from feed.js's slideshow ranking above, and
  // the #1107 scoped re-check proved it could be broken with the whole suite
  // green: folding couplePointsByGuest() into attachPhotoPoints changed the
  // rendered number and nothing failed. This pins the FIGURE itself, scoped
  // to the one card via the same id="photo-<id>" chunking
  // tests/per-photo-points.test.js's pointsInFeedBody uses.
  test('the feed card figure is unchanged across a couple like, even as getPoints moves', async () => {
    resetField();
    seedCrowdFavoriteNoise();
    const couple = makeGuest('Lilly', { isCouple: true });
    const viewer = makeGuest('AC4 Feed Viewer');
    const owner = makeGuest('AC4 Feed Owner');
    const taskId = db
      .prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)')
      .run('AC4 Feed Task', 4).lastInsertRowid;
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
         VALUES (?, ?, ?, ?, 0, 2)`
      )
      .run(owner.id, taskId, 'ac4feed.jpg', 'ac4feedt.jpg').lastInsertRowid;

    const agent = request.agent(app);
    signInGuest(app, viewer.token, agent);

    const before = await agent.get('/feed');
    expect(before.status).toBe(200);
    expect(pointsInFeedBody(before.text, submissionId)).toBe(6); // worth 4 + photo_bonus 2

    like(submissionId, couple.id);
    // The like really landed: the owner's AGGREGATE total moved by 1...
    expect(scoring.getPoints(owner.id)).toBe(7);

    const after = await agent.get('/feed');
    expect(after.status).toBe(200);
    // ...and the card's printed figure did not.
    expect(pointsInFeedBody(after.text, submissionId)).toBe(6);
  });
});

describe('Retroactive flag (PR review MINOR, #1107): toggling guests.is_couple moves totals both ways', () => {
  test('un-checking a liker as the couple strips the point on the very next read, re-checking restores it', () => {
    resetField();
    seedCrowdFavoriteNoise();
    const owner = makeGuest('Retro Owner');
    const liker = makeGuest('Retro Liker'); // not couple-flagged yet
    const submissionId = makeSubmission(owner.id);

    like(submissionId, liker.id);
    // liker is not couple-flagged yet, so this like pays only the ordinary
    // way: nothing to this term.
    expect(scoring.getPoints(owner.id)).toBe(1); // memory(1) only

    db.prepare('UPDATE guests SET is_couple = 1 WHERE id = ?').run(liker.id);
    // No new like happened; couplePointsByGuest() reads guests.is_couple
    // fresh on every call, so flipping the flag alone is retroactive: the
    // SAME existing like now counts.
    expect(scoring.getPoints(owner.id)).toBe(2); // memory(1) + couple(1)
    expect(scoring.couplePointsByGuest().get(owner.id)).toBe(1);

    db.prepare('UPDATE guests SET is_couple = 0 WHERE id = ?').run(liker.id);
    // And it moves back just as retroactively when the flag is cleared.
    expect(scoring.getPoints(owner.id)).toBe(1); // memory(1) only, again
    expect(scoring.couplePointsByGuest().has(owner.id)).toBe(false);
  });
});

describe('NIT (PR review, #1107): a couple-owned photo liked by the OTHER couple member', () => {
  test("a couple member liking the other couple member's own photo counts like any other couple like", () => {
    resetField();
    seedCrowdFavoriteNoise();
    const lilly = makeGuest('Lilly', { isCouple: true });
    const axel = makeGuest('Axel', { isCouple: true });
    const lillysPhoto = makeSubmission(lilly.id);

    expect(scoring.getPoints(lilly.id)).toBe(1); // memory(1), no like yet
    like(lillysPhoto, axel.id);

    expect(scoring.getPoints(lilly.id)).toBe(2); // memory(1) + couple(1)
    expect(scoring.couplePointsByGuest().get(lilly.id)).toBe(1);
  });
});
