// tests/crowd-favorites.test.js
// Issue #625: the crowd-favorites engine. Likes are votes; visible photos
// (task-linked or memories — memories compete, per this issue's settled
// rule) are ranked by like count using STANDARD-COMPETITION ranking
// (rank.standardRank), deliberately different from the leaderboard's DENSE
// ranking (#626, tests/leaderboard-ties.test.js): a tie at a crowd-favorite
// spot CONSUMES the ranks beneath it, which is what keeps the paying set
// bounded near 5 regardless of party scale.
//
//   AC1 — [7,5,5,3,2,1] -> ranks 1,2,2,4,5 paying 5,4,4,2,1; the 1-like photo
//         (rank 6) does not place.
//   AC2 — a big tie for a spot consumes every rank beneath it.
//   AC3 — a guest sweeping the 3 highest distinct like counts places at
//         ranks 1/2/3 and collects 5+4+3=12 — no cap.
//   AC4 — a 0-like photo never places; a takedown drops a placing photo out,
//         shifts the ranks below it up, and its points leave the owner's
//         total; a restore reverses all three.
//   AC5 — every reader (getPoints, leaderboard()'s row.points,
//         feed.slideshowSequence()'s Most Liked section) agrees on the same
//         photos, at the same ranks, with the same crowd total per guest.
//   AC6 — a full like/unlike/takedown/restore cycle leaves guest_badges'
//         row count unchanged and creates no crowd-favorite catalog row —
//         nothing is ever materialized for a crowd-favorite placement.
//   AC7 — entering/moving the placing set records a live crowd_favorite
//         recap row (current rank/points, never stale); leaving it records
//         crowd_favorite_lost (no rank cited).
//   AC8 — leaderboard() calls crowdFavorites() exactly once, issuing exactly
//         one SQL statement, regardless of guest count.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let feed;
let photos;
let notifications;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  scoring = require('../src/services/scoring');
  feed = require('../src/services/feed');
  photos = require('../src/services/photos');
  notifications = require('../src/services/notifications');
});

// ---------------------------------------------------------------------------
// Seeding helpers.
// ---------------------------------------------------------------------------

// guests.id cascades to submissions/likes/comments/guest_badges/
// notification_events (all `ON DELETE CASCADE` on guest_id — src/db.js), so
// deleting guests alone clears every table these tests seed; tasks/badges
// are cleared separately since neither cascades from guests.
function resetField() {
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
  db.prepare('DELETE FROM badges').run();
}

let seq = 0;

/** A guest with no submissions yet. @returns {{id: number, token: string}} */
function makeGuest(name) {
  seq += 1;
  const token = `crowdfav-token-${seq}`;
  const id = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  return { id, token };
}

/**
 * One visible MEMORY submission (task_id NULL — every fixture in this file
 * uses memories, both to exercise the settled "memories compete" rule and to
 * dodge the UNIQUE(guest_id, task_id) collision a shared task would risk;
 * SQLite treats every NULL task_id as distinct so a guest may hold any
 * number of memory rows).
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

function placingBySubmission() {
  return new Map(scoring.crowdFavorites().map((p) => [p.submission_id, p]));
}

// ---------------------------------------------------------------------------

describe('AC1: standard-competition ranking, [7,5,5,3,2,1]', () => {
  test('ranks 1,2,2,4,5 pay 5,4,4,2,1 — the rank-2 tie eats rank 3, and the 1-like photo (rank 6) does not place', () => {
    resetField();
    const owner = makeGuest('Owner');
    const s7 = makeSubmission(owner.id);
    const s5a = makeSubmission(owner.id);
    const s5b = makeSubmission(owner.id);
    const s3 = makeSubmission(owner.id);
    const s2 = makeSubmission(owner.id);
    const s1 = makeSubmission(owner.id);
    addLikes(s7, 7);
    addLikes(s5a, 5);
    addLikes(s5b, 5);
    addLikes(s3, 3);
    addLikes(s2, 2);
    addLikes(s1, 1);

    const placing = scoring.crowdFavorites();
    const bySub = placingBySubmission();

    expect(bySub.get(s7)).toMatchObject({ rank: 1, points: 5 });
    expect(bySub.get(s5a)).toMatchObject({ rank: 2, points: 4 });
    expect(bySub.get(s5b)).toMatchObject({ rank: 2, points: 4 });
    expect(bySub.get(s3)).toMatchObject({ rank: 4, points: 2 });
    expect(bySub.get(s2)).toMatchObject({ rank: 5, points: 1 });
    expect(bySub.has(s1)).toBe(false);
    // Nobody is ever paid rank 3 — the two-way tie at rank 2 consumed it.
    expect(placing.some((p) => p.rank === 3)).toBe(false);
    expect(placing.length).toBe(5);
  });
});

describe('AC2: a big tie consumes every rank beneath it', () => {
  test('[10, eight 8s, 6] -> rank1=10 (5pts), rank2=all eight 8s (4pts each), ranks 3/4/5 pay nobody, the 6 (rank10) does not place', () => {
    resetField();
    const owner = makeGuest('Owner');
    const s10 = makeSubmission(owner.id);
    addLikes(s10, 10);
    const eights = [];
    for (let i = 0; i < 8; i++) {
      const s = makeSubmission(owner.id);
      addLikes(s, 8);
      eights.push(s);
    }
    const s6 = makeSubmission(owner.id);
    addLikes(s6, 6);

    const placing = scoring.crowdFavorites();
    const bySub = placingBySubmission();

    expect(bySub.get(s10)).toMatchObject({ rank: 1, points: 5 });
    for (const s of eights) {
      expect(bySub.get(s)).toMatchObject({ rank: 2, points: 4 });
    }
    expect(bySub.has(s6)).toBe(false);
    expect(placing.some((p) => p.rank === 3)).toBe(false);
    expect(placing.some((p) => p.rank === 4)).toBe(false);
    expect(placing.some((p) => p.rank === 5)).toBe(false);
    // 1 (the 10) + 8 (the eights) = 9 placing photos; the big tie pays no
    // one else, unlike dense ranking, which has no such bound.
    expect(placing.length).toBe(9);
  });
});

describe('AC3: sweeping the 3 highest distinct like counts, no cap', () => {
  test('a guest owning the top 3 places at ranks 1/2/3 and collects 5+4+3=12', () => {
    resetField();
    const sweeper = makeGuest('Sweeper');
    const other = makeGuest('Other');
    const s1 = makeSubmission(sweeper.id);
    const s2 = makeSubmission(sweeper.id);
    const s3 = makeSubmission(sweeper.id);
    const filler = makeSubmission(other.id);
    addLikes(s1, 9);
    addLikes(s2, 6);
    addLikes(s3, 4);
    addLikes(filler, 1);

    const sweeperPlacing = scoring.crowdFavorites().filter((p) => p.guest_id === sweeper.id);
    expect(sweeperPlacing.length).toBe(3);
    expect(sweeperPlacing.map((p) => p.rank).sort()).toEqual([1, 2, 3]);
    expect(sweeperPlacing.map((p) => p.points).sort((a, b) => b - a)).toEqual([5, 4, 3]);
    expect(scoring.crowdPointsByGuest().get(sweeper.id)).toBe(12);

    // getPoints reads the same crowd total. The sweeper's 3 memories all land
    // on the same event-local day (created "now"), so memoryDayCount
    // contributes exactly +1 on top (a Set of days, not a count of memories)
    // — every other term (worth/photoBonus/bonusAmount/guest bonus/starter/
    // award) is 0 for this guest, so the total is exactly 12 + 1 = 13.
    expect(scoring.getPoints(sweeper.id)).toBe(13);
  });
});

describe('AC4: a 0-like photo never places; takedown/restore move the placing set and the owner total', () => {
  test('takedown drops a placing photo, shifts ranks below it up, and removes its points; restore reverses all three', () => {
    resetField();
    const owner = makeGuest('Owner');
    const zero = makeSubmission(owner.id);
    const s5 = makeSubmission(owner.id);
    const s3 = makeSubmission(owner.id);
    addLikes(s5, 5);
    addLikes(s3, 3);
    // `zero` has no likes at all.

    let bySub = placingBySubmission();
    expect(bySub.has(zero)).toBe(false);
    expect(bySub.get(s5)).toMatchObject({ rank: 1, points: 5 });
    expect(bySub.get(s3)).toMatchObject({ rank: 2, points: 4 });
    expect(scoring.crowdPointsByGuest().get(owner.id)).toBe(9);

    photos.hideSubmission(s5);

    bySub = placingBySubmission();
    expect(bySub.has(s5)).toBe(false);
    // s3 shifts up to rank 1 now that s5 is gone.
    expect(bySub.get(s3)).toMatchObject({ rank: 1, points: 5 });
    expect(scoring.crowdPointsByGuest().get(owner.id)).toBe(5);

    photos.restoreSubmission(s5);

    bySub = placingBySubmission();
    expect(bySub.get(s5)).toMatchObject({ rank: 1, points: 5 });
    expect(bySub.get(s3)).toMatchObject({ rank: 2, points: 4 });
    expect(scoring.crowdPointsByGuest().get(owner.id)).toBe(9);
  });
});

describe('AC5: getPoints, leaderboard(), and feed.slideshowSequence() all agree', () => {
  test('a tie, a sweeper, a placing memory, and a taken-down former favorite reconcile across every reader', () => {
    resetField();

    const sweep = makeGuest('Sweep Guest');
    const tieA = makeGuest('Tie Guest A');
    const tieB = makeGuest('Tie Guest B');
    const memoryGuest = makeGuest('Memory Guest');
    const formerGuest = makeGuest('Former Guest');

    const sSweep1 = makeSubmission(sweep.id);
    const sSweep2 = makeSubmission(sweep.id);
    const sTieA = makeSubmission(tieA.id);
    const sTieB = makeSubmission(tieB.id);
    const sMemory = makeSubmission(memoryGuest.id);
    // A former favorite: liked, but ALREADY taken down — excluded from every
    // reader by VISIBLE_WHERE regardless of its like count.
    const sFormer = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, NULL, ?, ?, 1)`
      )
      .run(formerGuest.id, 'former.jpg', 'former-thumb.jpg').lastInsertRowid;

    addLikes(sSweep1, 6); // rank 1 -> 5 pts
    addLikes(sSweep2, 5); // rank 2 -> 4 pts
    addLikes(sTieA, 4); // rank 3 (tied) -> 3 pts
    addLikes(sTieB, 4); // rank 3 (tied) -> 3 pts
    addLikes(sMemory, 3); // rank 5 (the rank-3 tie consumes rank 4) -> 1 pt
    addLikes(sFormer, 2); // never counted — taken_down = 1

    // --- crowdFavorites() itself -------------------------------------------
    const bySub = placingBySubmission();
    expect(bySub.get(sSweep1)).toMatchObject({ rank: 1, points: 5 });
    expect(bySub.get(sSweep2)).toMatchObject({ rank: 2, points: 4 });
    expect(bySub.get(sTieA)).toMatchObject({ rank: 3, points: 3 });
    expect(bySub.get(sTieB)).toMatchObject({ rank: 3, points: 3 });
    expect(bySub.get(sMemory)).toMatchObject({ rank: 5, points: 1 });
    expect(bySub.has(sFormer)).toBe(false);

    // Expected per-guest getPoints: crowd total + 1 memory-day (every guest
    // here has exactly one visible memory, all on the same event-local day)
    // + 0 for every other term. formerGuest's only submission is taken down,
    // so it has NO visible memory at all: memoryDayCount = 0, crowd = 0.
    const expected = {
      [sweep.id]: 9 + 1, // 5 + 4 crowd, +1 memory day
      [tieA.id]: 3 + 1,
      [tieB.id]: 3 + 1,
      [memoryGuest.id]: 1 + 1,
      [formerGuest.id]: 0,
    };

    // --- getPoints ------------------------------------------------------
    for (const [guestId, points] of Object.entries(expected)) {
      expect(scoring.getPoints(Number(guestId))).toBe(points);
    }

    // --- leaderboard() ----------------------------------------------------
    const board = scoring.leaderboard();
    const boardById = new Map(board.map((r) => [r.id, r]));
    for (const [guestId, points] of Object.entries(expected)) {
      expect(boardById.get(Number(guestId)).points).toBe(points);
    }

    // --- feed.slideshowSequence()'s Most Liked opener ----------------------
    const sequence = feed.slideshowSequence();
    expect(sequence[0]).toMatchObject({ type: 'title', title: 'Most Liked' });
    const titleIdx = sequence.findIndex((item) => item.type === 'title');
    const afterTitle = sequence.slice(titleIdx + 1);
    const nextTitleOffset = afterTitle.findIndex((item) => item.type === 'title');
    const openerPhotos = nextTitleOffset === -1 ? afterTitle : afterTitle.slice(0, nextTitleOffset);

    // Exactly the 5 placing photos — the taken-down former favorite never
    // appears anywhere in the sequence.
    expect(openerPhotos.length).toBe(5);
    expect(openerPhotos.some((p) => p.guest_name === 'Former Guest')).toBe(false);

    // Winner-last (countdown to the winner): the rank-1 sweep photo renders
    // last and carries the winner flag; nobody else does.
    const winner = openerPhotos[openerPhotos.length - 1];
    expect(winner.winner).toBe(true);
    expect(winner.guest_name).toBe('Sweep Guest');
    expect(winner.rankLabel).toBe('Crowd favorite');
    expect(openerPhotos.filter((p) => p.winner).length).toBe(1);

    const byGuestName = new Map(openerPhotos.map((p) => [p.guest_name, p]));
    expect(byGuestName.get('Memory Guest')).toMatchObject({ rank: 5, rankLabel: '5th place' });
    expect(byGuestName.get('Tie Guest A')).toMatchObject({ rank: 3, rankLabel: '3rd place' });
    expect(byGuestName.get('Tie Guest B')).toMatchObject({ rank: 3, rankLabel: '3rd place' });
  });
});

describe('AC6: a full like/unlike/takedown/restore cycle never materializes a badge', () => {
  test('guest_badges row count is unchanged before and after; no crowd-favorite catalog row exists', async () => {
    resetField();
    const owner = makeGuest('Cycle Owner');
    const liker = makeGuest('Cycle Liker');
    const submissionId = makeSubmission(owner.id);

    const before = db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n;

    const agent = signInGuest(app, liker.token);
    await agent.post(`/p/${submissionId}/like`).type('form').send({}); // like
    await agent.post(`/p/${submissionId}/like`).type('form').send({}); // unlike

    photos.hideSubmission(submissionId);
    photos.restoreSubmission(submissionId);

    const after = db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n;
    expect(after).toBe(before);

    const crowdCatalogRow = db.prepare("SELECT 1 FROM badges WHERE code LIKE '%CROWD%'").get();
    expect(crowdCatalogRow).toBeUndefined();
  });
});

describe('AC7: entering/leaving the placing set records a live recap row, never a stale rank', () => {
  test('a like that places a photo records crowd_favorite; a takedown that drops it out records crowd_favorite_lost', async () => {
    resetField();
    const owner = makeGuest('Recap Owner');
    const liker = makeGuest('Recap Liker');
    const submissionId = makeSubmission(owner.id);

    // A single like with no competing liked photo is enough to place at
    // rank 1 — this exercises the like-toggle emit path in community.js.
    const agent = signInGuest(app, liker.token);
    await agent.post(`/p/${submissionId}/like`).type('form').send({});

    let recap = notifications.getRecap(owner.id);
    const goldRow = recap.rows.find((r) => r.kind === 'gold');
    expect(goldRow).toBeDefined();
    expect(goldRow.dead).toBe(false);
    expect(goldRow.href).toBe(`/p/${submissionId}`);
    const goldText = goldRow.parts.map((p) => p.text).join('');
    expect(goldText).toContain('#1 crowd favorite');
    expect(goldText).toContain('+5 pts');

    // A takedown (photos.hideSubmission — the second emit path) drops the
    // photo out of the placing set entirely.
    photos.hideSubmission(submissionId);

    recap = notifications.getRecap(owner.id);
    const lossRow = recap.rows.find(
      (r) =>
        r.kind === 'loss' &&
        r.parts
          .map((p) => p.text)
          .join('')
          .includes('dropped out')
    );
    expect(lossRow).toBeDefined();
    expect(lossRow.dead).toBe(true);
    expect(lossRow.href).toBeNull();

    // STORED events are permanent (issue #644 design) — the earlier gold row
    // is still present alongside the new loss row, not replaced by it.
    expect(recap.rows.some((r) => r.kind === 'gold')).toBe(true);
  });

  test('a crowd_favorite row whose photo has since left the placing set again renders the rank-free fallback, never a stale number', () => {
    resetField();
    const owner = makeGuest('Stale Recap Owner');
    // No likes at all — this photo is NOT currently in the placing set.
    // Recording the event directly (bypassing recordCrowdFavoriteChanges)
    // simulates the race KIND_VIEW.crowd_favorite.parts()'s fallback guards:
    // a stored crowd_favorite row whose photo has moved out of the placing
    // set again by the time the recap actually renders it.
    const submissionId = makeSubmission(owner.id);
    notifications.recordEvent(owner.id, 'crowd_favorite', { submissionId });

    const recap = notifications.getRecap(owner.id);
    const row = recap.rows.find((r) => r.kind === 'gold');
    expect(row).toBeDefined();
    const text = row.parts.map((p) => p.text).join('');
    expect(text).toBe('Your photo is a crowd favorite');
    expect(text).not.toContain('#');
  });
});

describe('AC8: leaderboard() issues exactly one crowd-favorites SQL statement, regardless of guest count', () => {
  // Spies on the SHARED better-sqlite3 Statement prototype's `.all` method
  // (every prepared statement in the process, from any Database instance,
  // shares one prototype) and counts only calls whose own `.source` (the
  // statement's raw SQL text, a native getter) contains a substring unique
  // to scoring.js's crowd-favorites query — not a count of every `.all()`
  // call leaderboard() makes (which already grows with guest count through
  // its per-guest stmtBadgesForGuest call), and not wall-clock timing.
  function countCrowdFavoritesQueries(guestCount) {
    resetField();
    for (let i = 0; i < guestCount; i++) {
      const g = makeGuest(`AC8 Guest ${i}`);
      const s = makeSubmission(g.id);
      addLikes(s, i + 1);
    }

    const proto = Object.getPrototypeOf(db.prepare('SELECT 1'));
    const original = proto.all;
    let callCount = 0;
    proto.all = function (...args) {
      if (typeof this.source === 'string' && this.source.includes('like_count > 0')) {
        callCount += 1;
      }
      return original.apply(this, args);
    };
    try {
      scoring.leaderboard();
    } finally {
      proto.all = original;
    }
    return callCount;
  }

  test('exactly one query for a 2-guest field and for a 20-guest field', () => {
    expect(countCrowdFavoritesQueries(2)).toBe(1);
    expect(countCrowdFavoritesQueries(20)).toBe(1);
  });
});
