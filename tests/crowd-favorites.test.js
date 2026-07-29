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
//   AC3 — SUPERSEDED by issue #896 (2026-07-27): a guest's own multiple
//         liked photos no longer sweep several placing slots. Each guest
//         appears AT MOST ONCE in the placing set, represented by their
//         single best photo (highest like_count, then lowest submission_id
//         tiebreak) — see the "issue #896" describe blocks below for the
//         new distinct-count and tied-count coverage, and AC1/AC2/AC4/AC5
//         above were rewritten to seed each ladder rung from a DIFFERENT
//         guest (dedupe would otherwise collapse a same-owner ladder to one
//         entry, no longer exercising standardRank's own tie/skip logic).
//   AC4 — a 0-like photo never places; a takedown drops a placing photo out,
//         shifts the ranks below it up, and its points leave the owner's
//         total; a restore reverses all three.
//   AC5 — every reader (getPoints, leaderboard()'s row.points,
//         feed.slideshowSequence()'s Most Liked section) agrees on the same
//         photos, at the same ranks, with the same crowd total per guest.
//   AC6 — a full like/unlike/takedown/restore cycle leaves guest_badges'
//         row count unchanged and creates no crowd-favorite catalog row —
//         nothing is ever materialized for a crowd-favorite placement.
//   AC7 — SUPERSEDED by issue #895 (2026-07-27): a recap event is now a
//         per-guest PLACING-STATUS fact, not a per-photo rank fact. Entering
//         the placing set records a live crowd_favorite recap row (current
//         rank/points, read by guest_id, never stale even across a #896
//         representative-photo swap); leaving it entirely records
//         crowd_favorite_lost (no rank cited); staying in the set — a rank
//         shuffle from someone else's like, or a swap of which of the
//         guest's own tied photos represents them — records nothing.
//   AC8 — leaderboard() calls crowdFavorites() exactly once, issuing exactly
//         one SQL statement, regardless of guest count.
//
// Issue #896 (2026-07-27) — per-guest dedupe, before ranking: a guest owning
// N>1 visible liked photos is reduced to their single best photo (highest
// like_count, then lowest submission_id) BEFORE standardRank ever runs, for
// both tied and distinct like-counts. This reverses #625 AC3's old "no-cap
// sweep" rule entirely — see the "issue #896" describe blocks below.
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
    // Six DIFFERENT guests (issue #896 dedupes to one photo per guest,
    // before ranking) so this ladder still exercises standardRank's own
    // tie/skip behavior rather than being collapsed to one entry.
    const gs7 = makeGuest('Guest 7');
    const gs5a = makeGuest('Guest 5a');
    const gs5b = makeGuest('Guest 5b');
    const gs3 = makeGuest('Guest 3');
    const gs2 = makeGuest('Guest 2');
    const gs1 = makeGuest('Guest 1');
    const s7 = makeSubmission(gs7.id);
    const s5a = makeSubmission(gs5a.id);
    const s5b = makeSubmission(gs5b.id);
    const s3 = makeSubmission(gs3.id);
    const s2 = makeSubmission(gs2.id);
    const s1 = makeSubmission(gs1.id);
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
    // Ten DIFFERENT guests — issue #896 dedupes to one photo per guest, so a
    // big TIE must span distinct owners to still place more than one photo.
    const ownerTop = makeGuest('Top Owner');
    const s10 = makeSubmission(ownerTop.id);
    addLikes(s10, 10);
    const eights = [];
    for (let i = 0; i < 8; i++) {
      const g = makeGuest(`Eight Owner ${i}`);
      const s = makeSubmission(g.id);
      addLikes(s, 8);
      eights.push(s);
    }
    const ownerSix = makeGuest('Six Owner');
    const s6 = makeSubmission(ownerSix.id);
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

describe('AC3: SUPERSEDED by issue #896 — a guest no longer sweeps multiple slots with their own photos', () => {
  test('distinct like counts: A (9/6/4 likes) places once at rank 1 for 5 points — not 11 — while B (5 likes) places at rank 2', () => {
    resetField();
    const a = makeGuest('Guest A');
    const b = makeGuest('Guest B');
    const a9 = makeSubmission(a.id);
    const a6 = makeSubmission(a.id);
    const a4 = makeSubmission(a.id);
    const b5 = makeSubmission(b.id);
    addLikes(a9, 9);
    addLikes(a6, 6);
    addLikes(a4, 4);
    addLikes(b5, 5);

    const aPlacing = scoring.crowdFavorites().filter((p) => p.guest_id === a.id);
    expect(aPlacing.length).toBe(1);
    expect(aPlacing[0]).toMatchObject({ submission_id: a9, rank: 1, points: 5 });
    expect(scoring.crowdPointsByGuest().get(a.id)).toBe(5);

    const bPlacing = scoring.crowdFavorites().filter((p) => p.guest_id === b.id);
    expect(bPlacing.length).toBe(1);
    expect(bPlacing[0]).toMatchObject({ submission_id: b5, rank: 2, points: 4 });

    // A's own weaker photos never appear in the placing set at all — dedupe
    // drops them BEFORE ranking, they don't just rank lower.
    const bySub = placingBySubmission();
    expect(bySub.has(a6)).toBe(false);
    expect(bySub.has(a4)).toBe(false);

    // getPoints reads the same crowd total. A's 3 memories all land on the
    // same event-local day, so memoryDayCount contributes exactly +1 on top
    // — every other term is 0 for this guest, so the total is 5 + 1 = 6. Under
    // the old no-cap sweep rule this fixture (9/6/5/4 likes -> ranks 1/2/3/4)
    // paid A ranks 1, 2 and 4 for 5 + 4 + 2 = 11 crowd points, 11 + 1 = 12 total.
    expect(scoring.getPoints(a.id)).toBe(6);
  });

  test('tied like counts: A (two photos tied at 10 likes) places once at rank 1 — the lower submission_id wins the tiebreak — while B (8 likes) places at rank 2', () => {
    resetField();
    const a = makeGuest('Tie Guest A');
    const b = makeGuest('Tie Guest B');
    const a10a = makeSubmission(a.id);
    const a10b = makeSubmission(a.id);
    const b8 = makeSubmission(b.id);
    addLikes(a10a, 10);
    addLikes(a10b, 10);
    addLikes(b8, 8);

    const aPlacing = scoring.crowdFavorites().filter((p) => p.guest_id === a.id);
    expect(aPlacing.length).toBe(1);
    // a10a and a10b tie on like_count; stmtVisibleLikeCounts' own
    // submission_id ASC tiebreak makes a10a (the lower id) A's "best" row,
    // and dedupe keeps the FIRST row seen per guest_id.
    expect(aPlacing[0]).toMatchObject({ submission_id: a10a, rank: 1, points: 5 });

    const bPlacing = scoring.crowdFavorites().filter((p) => p.guest_id === b.id);
    expect(bPlacing.length).toBe(1);
    expect(bPlacing[0]).toMatchObject({ submission_id: b8, rank: 2, points: 4 });

    const bySub = placingBySubmission();
    expect(bySub.has(a10b)).toBe(false);
  });
});

describe('AC4: a 0-like photo never places; takedown/restore move the placing set and the owner total', () => {
  test('takedown drops a placing photo, shifts ranks below it up, and removes its points; restore reverses all three', () => {
    resetField();
    // s5 and s3 are owned by DIFFERENT guests (issue #896 dedupes to one
    // photo per guest, so both must place simultaneously to exercise a
    // takedown shifting one guest's rank while leaving the other's alone).
    // `zero` shares owner's guest_id — it never places regardless of dedupe,
    // since it is filtered out by like_count > 0 before dedupe even runs.
    const owner = makeGuest('Owner');
    const other = makeGuest('Other');
    const zero = makeSubmission(owner.id);
    const s5 = makeSubmission(owner.id);
    const s3 = makeSubmission(other.id);
    addLikes(s5, 5);
    addLikes(s3, 3);
    // `zero` has no likes at all.

    let bySub = placingBySubmission();
    expect(bySub.has(zero)).toBe(false);
    expect(bySub.get(s5)).toMatchObject({ rank: 1, points: 5 });
    expect(bySub.get(s3)).toMatchObject({ rank: 2, points: 4 });
    expect(scoring.crowdPointsByGuest().get(owner.id)).toBe(5);
    expect(scoring.crowdPointsByGuest().get(other.id)).toBe(4);

    photos.hideSubmission(s5);

    bySub = placingBySubmission();
    expect(bySub.has(s5)).toBe(false);
    // s3 shifts up to rank 1 now that s5 is gone.
    expect(bySub.get(s3)).toMatchObject({ rank: 1, points: 5 });
    expect(scoring.crowdPointsByGuest().get(owner.id)).toBeUndefined();
    expect(scoring.crowdPointsByGuest().get(other.id)).toBe(5);

    photos.restoreSubmission(s5);

    bySub = placingBySubmission();
    expect(bySub.get(s5)).toMatchObject({ rank: 1, points: 5 });
    expect(bySub.get(s3)).toMatchObject({ rank: 2, points: 4 });
    expect(scoring.crowdPointsByGuest().get(owner.id)).toBe(5);
    expect(scoring.crowdPointsByGuest().get(other.id)).toBe(4);
  });
});

describe('AC5: getPoints, leaderboard(), and feed.slideshowSequence() all agree', () => {
  test('a leader, a tie, a placing memory, and a taken-down former favorite reconcile across every reader', () => {
    resetField();

    // Issue #896: each guest holds exactly ONE submission here (a second
    // submission for `leader` would simply dedupe out before ranking, so it
    // adds nothing this reconciliation test needs to prove).
    const leader = makeGuest('Leader Guest');
    const tieA = makeGuest('Tie Guest A');
    const tieB = makeGuest('Tie Guest B');
    const memoryGuest = makeGuest('Memory Guest');
    const formerGuest = makeGuest('Former Guest');

    const sLeader = makeSubmission(leader.id);
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

    addLikes(sLeader, 6); // rank 1 -> 5 pts
    addLikes(sTieA, 4); // rank 2 (tied) -> 4 pts
    addLikes(sTieB, 4); // rank 2 (tied) -> 4 pts
    addLikes(sMemory, 3); // rank 4 (the rank-2 tie consumes rank 3) -> 2 pts
    addLikes(sFormer, 2); // never counted — taken_down = 1

    // --- crowdFavorites() itself -------------------------------------------
    const bySub = placingBySubmission();
    expect(bySub.get(sLeader)).toMatchObject({ rank: 1, points: 5 });
    expect(bySub.get(sTieA)).toMatchObject({ rank: 2, points: 4 });
    expect(bySub.get(sTieB)).toMatchObject({ rank: 2, points: 4 });
    expect(bySub.get(sMemory)).toMatchObject({ rank: 4, points: 2 });
    expect(bySub.has(sFormer)).toBe(false);

    // Expected per-guest getPoints: crowd total + 1 memory-day (every guest
    // here has exactly one visible memory, all on the same event-local day)
    // + 0 for every other term. formerGuest's only submission is taken down,
    // so it has NO visible memory at all: memoryDayCount = 0, crowd = 0.
    const expected = {
      [leader.id]: 5 + 1,
      [tieA.id]: 4 + 1,
      [tieB.id]: 4 + 1,
      [memoryGuest.id]: 2 + 1,
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

    // Exactly the 4 placing photos — the taken-down former favorite never
    // appears anywhere in the sequence.
    expect(openerPhotos.length).toBe(4);
    expect(openerPhotos.some((p) => p.guest_name === 'Former Guest')).toBe(false);

    // Winner-last (countdown to the winner): the rank-1 leader photo renders
    // last and carries the winner flag; nobody else does.
    const winner = openerPhotos[openerPhotos.length - 1];
    expect(winner.winner).toBe(true);
    expect(winner.guest_name).toBe('Leader Guest');
    expect(winner.rankLabel).toBe('Crowd favorite');
    expect(openerPhotos.filter((p) => p.winner).length).toBe(1);

    const byGuestName = new Map(openerPhotos.map((p) => [p.guest_name, p]));
    expect(byGuestName.get('Memory Guest')).toMatchObject({ rank: 4, rankLabel: '4th place' });
    expect(byGuestName.get('Tie Guest A')).toMatchObject({ rank: 2, rankLabel: '2nd place' });
    expect(byGuestName.get('Tie Guest B')).toMatchObject({ rank: 2, rankLabel: '2nd place' });
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

  test('a crowd_favorite row whose guest has since left the placing set again renders the rank-free fallback, never a stale number', () => {
    resetField();
    const owner = makeGuest('Stale Recap Owner');
    // No likes at all — this guest is NOT currently in the placing set.
    // Recording the event directly (bypassing recordCrowdFavoriteChanges)
    // simulates the race KIND_VIEW.crowd_favorite.parts()'s fallback guards:
    // a stored crowd_favorite row whose guest has moved out of the placing
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

// Count of stored crowd_favorite/crowd_favorite_lost rows for one guest,
// read straight off notification_events rather than through getRecap's
// pagination/checkpoint machinery — the precise thing issue #895's AC1/AC4
// promise ("no new ... event row is written" / "exactly one new ... event is
// written") is a row count, not a recap-rendering concern.
function kindCounts(guestId) {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS n FROM notification_events
        WHERE guest_id = ? AND kind IN ('crowd_favorite', 'crowd_favorite_lost')
        GROUP BY kind`
    )
    .all(guestId);
  const counts = { crowd_favorite: 0, crowd_favorite_lost: 0 };
  for (const row of rows) {
    counts[row.kind] = row.n;
  }
  return counts;
}

describe('issue #895: crowd-favorite events are a per-guest placing-status fact, not a per-photo rank fact', () => {
  test('AC1: a guest who stays placing records nothing when only their numeric rank shifts', () => {
    resetField();
    const stable = makeGuest('Shuffle Stable Guest');
    const mover = makeGuest('Shuffle Mover Guest');
    const sStable = makeSubmission(stable.id);
    const sMover = makeSubmission(mover.id);
    addLikes(sStable, 5); // stable starts at rank 1
    addLikes(sMover, 3); // mover starts at rank 2

    // Both enter the placing set for the first time.
    scoring.recordCrowdFavoriteChanges([]);
    expect(kindCounts(stable.id)).toMatchObject({ crowd_favorite: 1, crowd_favorite_lost: 0 });

    // Mover overtakes stable via a fresh batch of likes on MOVER's photo —
    // stable never touches their own photo, yet stable's numeric rank shifts
    // from 1 to 2. Stable stays in the placing set throughout.
    const before = scoring.crowdFavorites();
    addLikes(sMover, 3); // mover now at 6 likes, ahead of stable's 5
    scoring.recordCrowdFavoriteChanges(before);

    const bySub = placingBySubmission();
    expect(bySub.get(sStable)).toMatchObject({ rank: 2 }); // shifted down from 1
    expect(bySub.get(sMover)).toMatchObject({ rank: 1 });

    // Still exactly the one entry event from before the shuffle — no new row.
    expect(kindCounts(stable.id)).toMatchObject({ crowd_favorite: 1, crowd_favorite_lost: 0 });
  });

  test('AC1 (#896 swap): a representative-photo swap between a guest’s own tied photos records nothing while they stay placing', () => {
    resetField();
    const owner = makeGuest('Swap Owner');
    const rival = makeGuest('Swap Rival');
    const sFirst = makeSubmission(owner.id);
    const sSecond = makeSubmission(owner.id);
    const sRival = makeSubmission(rival.id);
    addLikes(sFirst, 5); // owner's current best photo -> places at rank 1
    addLikes(sRival, 3);

    scoring.recordCrowdFavoriteChanges([]); // owner + rival both enter
    expect(kindCounts(owner.id)).toMatchObject({ crowd_favorite: 1, crowd_favorite_lost: 0 });

    // owner's SECOND photo overtakes their first (6 > 5) — the dedupe
    // tiebreak now picks sSecond as owner's representative instead of
    // sFirst, but owner themselves never left the placing set.
    const before = scoring.crowdFavorites();
    addLikes(sSecond, 6);
    scoring.recordCrowdFavoriteChanges(before);

    const ownerPlacing = scoring.crowdFavorites().filter((p) => p.guest_id === owner.id);
    expect(ownerPlacing.length).toBe(1);
    expect(ownerPlacing[0].submission_id).toBe(sSecond); // representative swapped

    // Still exactly the one entry event — the swap itself is not news.
    expect(kindCounts(owner.id)).toMatchObject({ crowd_favorite: 1, crowd_favorite_lost: 0 });
  });

  test('AC4: a guest who exits and later re-enters the placing set records exactly one new crowd_favorite event', () => {
    resetField();
    const owner = makeGuest('Reentry Owner');
    const rival = makeGuest('Reentry Rival');
    const submissionId = makeSubmission(owner.id);
    const rivalSubmission = makeSubmission(rival.id);
    addLikes(submissionId, 5); // owner places at rank 1
    addLikes(rivalSubmission, 3);

    scoring.recordCrowdFavoriteChanges([]); // owner + rival both enter
    expect(kindCounts(owner.id)).toMatchObject({ crowd_favorite: 1, crowd_favorite_lost: 0 });

    // Owner's only placing photo is taken down — they exit the set entirely.
    // photos.hideSubmission runs its own before/after diff internally (the
    // same transaction the live takedown route uses), so this is not a
    // second, redundant recordCrowdFavoriteChanges call.
    photos.hideSubmission(submissionId);
    expect(kindCounts(owner.id)).toMatchObject({ crowd_favorite: 1, crowd_favorite_lost: 1 });

    // Restored — owner re-enters the placing set.
    photos.restoreSubmission(submissionId);
    expect(kindCounts(owner.id)).toMatchObject({ crowd_favorite: 2, crowd_favorite_lost: 1 });
  });

  test('AC5: the recap reads the CURRENT rank by owning guest even when the stored event’s submission is no longer the representative', () => {
    resetField();
    const owner = makeGuest('Recap Swap Owner');
    const rival = makeGuest('Recap Swap Rival');
    const sFirst = makeSubmission(owner.id);
    const sSecond = makeSubmission(owner.id);
    const sRival = makeSubmission(rival.id);
    addLikes(sFirst, 5); // owner places at rank 1 on sFirst
    addLikes(sRival, 3);

    // The stored event names sFirst — the guest's representative AT THE TIME
    // it was recorded.
    notifications.recordEvent(owner.id, 'crowd_favorite', { submissionId: sFirst });

    // sSecond overtakes sFirst — owner's representative swaps, but owner is
    // still placing (now at rank 1 on sSecond instead).
    addLikes(sSecond, 7);
    const ownerPlacing = scoring.crowdFavorites().find((p) => p.guest_id === owner.id);
    expect(ownerPlacing.submission_id).toBe(sSecond);
    expect(ownerPlacing.rank).toBe(1);

    // The recap row (looked up by owner.id, not by the stored sFirst) must
    // still show the guest's CURRENT rank/points, not fall back to the
    // rank-free copy just because sFirst itself dropped out of the set.
    const recap = notifications.getRecap(owner.id);
    const goldRow = recap.rows.find((r) => r.kind === 'gold');
    expect(goldRow).toBeDefined();
    const text = goldRow.parts.map((p) => p.text).join('');
    expect(text).toContain('#1 crowd favorite');
    expect(text).toContain('+5 pts');
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

describe('issue #896 AC1/AC6: the reported bug — one guest, 20 photos tied at the top, places once', () => {
  test('20 visible photos owned by one guest, all tied at the same like count, place that guest once at rank 1 for 5 points', () => {
    resetField();
    const owner = makeGuest('Reported Bug Owner');
    const submissionIds = [];
    for (let i = 0; i < 20; i++) {
      const s = makeSubmission(owner.id);
      addLikes(s, 3); // every photo tied at 3 likes
      submissionIds.push(s);
    }

    const placing = scoring.crowdFavorites().filter((p) => p.guest_id === owner.id);
    expect(placing.length).toBe(1);
    expect(placing[0]).toMatchObject({ rank: 1, points: 5 });
    // stmtVisibleLikeCounts' own submission_id ASC tiebreak makes the FIRST
    // submitted photo (lowest id) this guest's "best" among the 20-way tie.
    expect(placing[0].submission_id).toBe(submissionIds[0]);
    expect(scoring.crowdPointsByGuest().get(owner.id)).toBe(5);

    // None of the other 19 tied photos ever appear in the placing set —
    // deduped out before ranking even runs, not merely ranked below 5th.
    const bySub = placingBySubmission();
    for (let i = 1; i < submissionIds.length; i++) {
      expect(bySub.has(submissionIds[i])).toBe(false);
    }
  });
});
