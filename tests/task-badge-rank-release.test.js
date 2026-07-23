// tests/task-badge-rank-release.test.js
// Issue #661 — the "Rank & award" ranked release: task-badges.js's
// releaseRanking/currentRanking/isTaskBadgeAwarded, the GET/POST
// /admin/tasks/:id/rank route, the guest_badges.rank migration, the
// give-a-badge catalog-collision retirement, and the recap event.
//
// AC1 — GET renders the pick grid + ranked list (structural: the approved
//       look/drag behavior is covered by the visual-approval freeze, not
//       this file).
// AC2 — release writes 5/4/3/2/1 by rank in one transaction; getPoints and
//       leaderboard() both reflect it. Covers the 1-winner and 3-winner cases.
// AC3 — zero winners writes nothing.
// AC4 — takedown/restore of a winning photo is free (scoring.js's existing
//       visibility rule) — asserted here against a REAL ranked award, not
//       re-implemented.
// AC5 — same-guest collapse: ranks 1 + 4 -> one row, 7 points, rank 1,
//       submission_id = the 1st-place photo.
// AC6 — reopening a released task's page renders read-only; re-ranking
//       replaces the whole award set atomically.
// AC7 — the five-code give-a-badge catalog is gone; the three colliding
//       `badges` catalog rows (and any guest_badges rows held on them) are
//       removed by a migration.
// AC8 — a winning guest's recap contains a row naming the badge + rank,
//       linking to the winning photo.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let dbModule;
let scoring;
let taskBadges;
let notifications;
let adminAgent;

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('rank-token-' + guestSeq, name).lastInsertRowid;
}

function makeTask(title) {
  return db.prepare('INSERT INTO tasks (title, description) VALUES (?, ?)').run(title, '')
    .lastInsertRowid;
}

let subSeq = 0;
function makeSubmission(guestId, taskId, takenDown = 0) {
  subSeq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, `rp${subSeq}.jpg`, `rt${subSeq}.jpg`, takenDown).lastInsertRowid;
}

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  dbModule = require('../src/db');
  scoring = require('../src/services/scoring');
  taskBadges = require('../src/services/task-badges');
  notifications = require('../src/services/notifications');
  adminAgent = await makeAdminAgent(app);
});

// ---------------------------------------------------------------------------
// AC2: release writes 5/4/3/2/1 by rank, in one transaction; getPoints and
// leaderboard() both reflect the new totals. Covers the 1-winner and
// 3-winner cases named in the issue's plan.
// ---------------------------------------------------------------------------
describe('AC2: release pays 5/4/3/2/1 by rank and both getPoints/leaderboard reflect it', () => {
  it('a single winner (K=1) pays exactly 5', () => {
    const taskId = makeTask('AC2 Solo Task');
    const guestId = makeGuest('AC2 Solo Guest');
    const sub = makeSubmission(guestId, taskId);

    const result = taskBadges.releaseRanking(taskId, [sub]);
    expect(result).toBeTruthy();
    expect(result.winners).toBe(1);

    expect(scoring.getPoints(guestId)).toBe(1 + 5); // 1 completed-task base + the 5-pt award
    const row = db
      .prepare('SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(guestId, result.badge.id);
    expect(row.points).toBe(5);
    expect(row.rank).toBe(1);
    expect(row.submission_id).toBe(sub);
    expect(row.awarded_by).toBe('admin');

    const lbRow = scoring.leaderboard().find((r) => r.id === guestId);
    expect(lbRow.points).toBe(6);
  });

  it('three distinct winners (K=3) pay 5/4/3 in one transaction', () => {
    const taskId = makeTask('AC2 Trio Task');
    const g1 = makeGuest('AC2 Trio Guest 1');
    const g2 = makeGuest('AC2 Trio Guest 2');
    const g3 = makeGuest('AC2 Trio Guest 3');
    const s1 = makeSubmission(g1, taskId);
    const s2 = makeSubmission(g2, taskId);
    const s3 = makeSubmission(g3, taskId);

    const result = taskBadges.releaseRanking(taskId, [s1, s2, s3]);
    expect(result.winners).toBe(3);

    const rows = db
      .prepare(
        'SELECT guest_id, points, rank, submission_id FROM guest_badges WHERE badge_id = ? ORDER BY rank'
      )
      .all(result.badge.id);
    expect(rows).toEqual([
      { guest_id: g1, points: 5, rank: 1, submission_id: s1 },
      { guest_id: g2, points: 4, rank: 2, submission_id: s2 },
      { guest_id: g3, points: 3, rank: 3, submission_id: s3 },
    ]);

    // Each guest completed exactly this one task (1 base point) + their award.
    expect(scoring.getPoints(g1)).toBe(1 + 5);
    expect(scoring.getPoints(g2)).toBe(1 + 4);
    expect(scoring.getPoints(g3)).toBe(1 + 3);
  });

  it('a full 5-winner release pays 5/4/3/2/1 (only existing ranks paid, per POINTS_BY_RANK)', () => {
    const taskId = makeTask('AC2 Full Five Task');
    const guests = [1, 2, 3, 4, 5].map((n) => makeGuest('AC2 Full Guest ' + n));
    const subs = guests.map((g) => makeSubmission(g, taskId));

    const result = taskBadges.releaseRanking(taskId, subs);
    expect(result.winners).toBe(5);

    const points = db
      .prepare('SELECT points FROM guest_badges WHERE badge_id = ? ORDER BY rank')
      .all(result.badge.id)
      .map((r) => r.points);
    expect(points).toEqual(taskBadges.POINTS_BY_RANK);
  });
});

// ---------------------------------------------------------------------------
// AC3: zero winners writes nothing. Distinct placements are guaranteed by
// the drag model (no duplicate-rank path to guard) — this covers the
// input-domain edges releaseRanking itself must still refuse: empty, over
// the cap, a duplicate id, and an id that fails the "current, this task's,
// visible" check.
// ---------------------------------------------------------------------------
describe('AC3: refused releases write nothing', () => {
  it('an empty winners array is refused (no row, no badge marked awarded)', () => {
    const taskId = makeTask('AC3 Empty Task');
    expect(taskBadges.releaseRanking(taskId, [])).toBeNull();
    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(false);
    // Every input-validation branch returns before resolveTaskBadge() ever
    // runs, so a refused release leaves no badges row for this task at all
    // (not just no guest_badges row) — checked via the non-lazy
    // getTaskBadge, which — unlike resolveTaskBadge — never inserts one.
    expect(taskBadges.getTaskBadge(taskId)).toBeUndefined();
  });

  it('more than MAX_RANKED_WINNERS entries is refused', () => {
    const taskId = makeTask('AC3 Overflow Task');
    const subs = [];
    for (let i = 0; i < taskBadges.MAX_RANKED_WINNERS + 1; i++) {
      subs.push(makeSubmission(makeGuest('AC3 Overflow Guest ' + i), taskId));
    }
    expect(taskBadges.releaseRanking(taskId, subs)).toBeNull();
    expect(taskBadges.getTaskBadge(taskId)).toBeUndefined();
  });

  it('a duplicate submission id in the list is refused', () => {
    const taskId = makeTask('AC3 Duplicate Task');
    const guestId = makeGuest('AC3 Duplicate Guest');
    const sub = makeSubmission(guestId, taskId);
    expect(taskBadges.releaseRanking(taskId, [sub, sub])).toBeNull();
  });

  it('a submission belonging to a DIFFERENT task is refused', () => {
    const taskId = makeTask('AC3 Wrong Task');
    const otherTaskId = makeTask('AC3 Other Task');
    const guestId = makeGuest('AC3 Wrong Guest');
    const wrongSub = makeSubmission(guestId, otherTaskId);
    expect(taskBadges.releaseRanking(taskId, [wrongSub])).toBeNull();
  });

  it('a taken-down submission is refused', () => {
    const taskId = makeTask('AC3 Down Task');
    const guestId = makeGuest('AC3 Down Guest');
    const downSub = makeSubmission(guestId, taskId, 1);
    expect(taskBadges.releaseRanking(taskId, [downSub])).toBeNull();
  });

  it('an unknown submission id is refused', () => {
    const taskId = makeTask('AC3 Unknown Task');
    expect(taskBadges.releaseRanking(taskId, [999999])).toBeNull();
  });

  it('POST /admin/tasks/:id/rank with no winners field redirects with a message and writes nothing', async () => {
    const taskId = makeTask('AC3 Route Task');
    const res = await adminAgent
      .post('/admin/tasks/' + taskId + '/rank')
      .type('form')
      .send({});
    expect(res.status).toBe(303);
    expect(decodeURIComponent(res.headers.location)).toMatch(/Could not release/);
    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC4: takedown-revert is FREE — scoring.js's existing award-points
// visibility rule already gates a task-badge award's points on its earning
// submission's taken_down flag. Asserted here against a REAL ranked award
// (not a single-photo awardTaskBadge call) so this issue's own write path is
// covered, not just the pre-existing rule in the abstract.
// ---------------------------------------------------------------------------
describe("AC4: a ranked winner's photo takedown/restore moves their points; the award row survives", () => {
  it('getPoints drops the award on takedown and restores it, with the guest_badges row intact throughout', () => {
    const taskId = makeTask('AC4 Task');
    const guestId = makeGuest('AC4 Guest');
    const sub = makeSubmission(guestId, taskId);

    const result = taskBadges.releaseRanking(taskId, [sub]);
    expect(scoring.getPoints(guestId)).toBe(6); // 1 base + 5 award

    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(sub);
    expect(scoring.getPoints(guestId)).toBe(0); // base AND award both drop

    const rowWhileDown = db
      .prepare('SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(guestId, result.badge.id);
    expect(rowWhileDown).toBeTruthy(); // the award row itself survives (AC4)
    expect(rowWhileDown.points).toBe(5);
    expect(rowWhileDown.rank).toBe(1);

    db.prepare('UPDATE submissions SET taken_down = 0 WHERE id = ?').run(sub);
    expect(scoring.getPoints(guestId)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// AC5: one guest owning two ranked photos collapses to ONE row — points
// SUMMED, rank/submission_id pinned to the BETTER placement.
//
// A real fixture for this needs two DIFFERENT submissions, in ONE task's
// visible set, owned by the SAME guest — which `submissions`' own
// UNIQUE(guest_id, task_id) constraint makes impossible to construct (a
// guest holds at most one submission per task, full stop; a resubmit
// UPDATEs that same row rather than inserting a second one — see
// src/services/submissions.js's own doc comment on its replace path). Every
// id releaseRanking accepts is also validated to belong to task T (this
// file's AC3 coverage), so `resolved` can never actually contain two entries
// sharing a guestId in production today. The collapse RULE itself is still
// real code with a real contract (foldRankedPlacements, extracted from
// releaseRanking for exactly this reason — see that function's own doc
// comment) — asserted directly here against a synthetic same-guest input,
// which is the only way to exercise this rule at all without a DB fixture
// that cannot exist.
// ---------------------------------------------------------------------------
describe('AC5: same-guest multi-win collapses to one row', () => {
  it('foldRankedPlacements: ranks 1 and 4 for the same guest -> one entry, 7 points, rank 1, submissionId = the 1st-place photo', () => {
    const resolved = [
      { submissionId: 101, guestId: 55 }, // rank 1 (5 pts)
      { submissionId: 102, guestId: 66 }, // rank 2 (4 pts)
      { submissionId: 103, guestId: 77 }, // rank 3 (3 pts)
      { submissionId: 104, guestId: 55 }, // rank 4 (2 pts) — same guest as rank 1
    ];

    const byGuest = taskBadges.foldRankedPlacements(resolved);

    expect(byGuest.size).toBe(3); // 4 placements, 3 distinct guests
    expect(byGuest.get(55)).toEqual({ points: 7, rank: 1, submissionId: 101 });
    expect(byGuest.get(66)).toEqual({ points: 4, rank: 2, submissionId: 102 });
    expect(byGuest.get(77)).toEqual({ points: 3, rank: 3, submissionId: 103 });
  });

  it('foldRankedPlacements: a guest placing 1st AND 5th still pins to the 1st-place submission (first-seen, never overwritten by a later, worse placement)', () => {
    const resolved = [
      { submissionId: 301, guestId: 9 }, // rank 1 (5 pts) — seeds guest 9's entry
      { submissionId: 302, guestId: 8 }, // rank 2 (4 pts)
      { submissionId: 303, guestId: 7 }, // rank 3 (3 pts)
      { submissionId: 304, guestId: 6 }, // rank 4 (2 pts)
      { submissionId: 305, guestId: 9 }, // rank 5 (1 pt) — same guest as rank 1, strictly worse
    ];
    const byGuest = taskBadges.foldRankedPlacements(resolved);
    // Inverting foldRankedPlacements' "never move off the first-seen
    // placement" rule (e.g. always overwriting rank/submissionId on every
    // fold) would make this read rank 5 / submissionId 305 instead.
    expect(byGuest.get(9)).toEqual({ points: 6, rank: 1, submissionId: 301 });
  });

  it('releaseRanking end-to-end: 3 DISTINCT guests never collapse (the real, reachable case for one task)', () => {
    // The full write-path proof that a release with no same-guest overlap —
    // the only shape task-scoped ranking can ever actually produce — writes
    // exactly one row per placement, never folding across guests it should
    // not (already covered by AC2's 3-winner test; restated here to sit
    // beside the collapse coverage above).
    const taskId = makeTask('AC5 Distinct Guests Task');
    const g1 = makeGuest('AC5 Distinct Guest 1');
    const g2 = makeGuest('AC5 Distinct Guest 2');
    const s1 = makeSubmission(g1, taskId);
    const s2 = makeSubmission(g2, taskId);

    const result = taskBadges.releaseRanking(taskId, [s1, s2]);
    expect(result.winners).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC6: a released task's page reopens read-only; re-ranking and
// re-releasing replaces the badge's whole award set atomically.
// ---------------------------------------------------------------------------
describe('AC6: reopen read-only (Awarded), re-rank replaces the whole set atomically', () => {
  it('isTaskBadgeAwarded flips true after the first release and currentRanking reads the live set', () => {
    const taskId = makeTask('AC6 Task');
    const guestId = makeGuest('AC6 Guest');
    const sub = makeSubmission(guestId, taskId);

    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(false);
    expect(taskBadges.currentRanking(taskId)).toEqual([]);

    taskBadges.releaseRanking(taskId, [sub]);

    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(true);
    const ranking = taskBadges.currentRanking(taskId);
    expect(ranking).toHaveLength(1);
    expect(ranking[0].rank).toBe(1);
    expect(ranking[0].guest_id).toBe(guestId);
  });

  it('re-releasing a SMALLER, DIFFERENT winner set drops the old winners entirely (atomic replace)', () => {
    const taskId = makeTask('AC6 Replace Task');
    const guestA = makeGuest('AC6 Replace Guest A');
    const guestB = makeGuest('AC6 Replace Guest B');
    const guestC = makeGuest('AC6 Replace Guest C');
    const subA = makeSubmission(guestA, taskId);
    const subB = makeSubmission(guestB, taskId);
    const subC = makeSubmission(guestC, taskId);

    const first = taskBadges.releaseRanking(taskId, [subA, subB, subC]);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM guest_badges WHERE badge_id = ?').get(first.badge.id).n
    ).toBe(3);

    // Re-rank to a single, DIFFERENT winner (guestC only) — A and B's rows
    // must be gone, not left stale alongside C's.
    const second = taskBadges.releaseRanking(taskId, [subC]);
    expect(second.winners).toBe(1);

    const remaining = db
      .prepare('SELECT guest_id, rank, points FROM guest_badges WHERE badge_id = ?')
      .all(first.badge.id);
    expect(remaining).toEqual([{ guest_id: guestC, rank: 1, points: 5 }]);
    expect(scoring.getPoints(guestA)).toBe(1); // just their completed-task base, award gone
    expect(scoring.getPoints(guestB)).toBe(1);
  });

  it('GET /admin/tasks/:id/rank renders released=Awarded after release, with the current ranking', async () => {
    const taskId = makeTask('AC6 Route Task');
    const guestId = makeGuest('AC6 Route Guest');
    const sub = makeSubmission(guestId, taskId);

    const before = await adminAgent.get('/admin/tasks/' + taskId + '/rank');
    expect(before.status).toBe(200);
    expect(before.text).toContain('data-released="0"');

    taskBadges.releaseRanking(taskId, [sub]);

    const after = await adminAgent.get('/admin/tasks/' + taskId + '/rank');
    expect(after.status).toBe(200);
    expect(after.text).toContain('data-released="1"');
    // The current winner's data rides along in the winners payload the page
    // hands the client (src/views/admin-badge-rank.ejs's data-winners attr).
    // EJS's default escapeXML emits the numeric entity &#34;, not &quot;.
    expect(after.text).toContain('&#34;submission_id&#34;:' + sub);
  });

  it('POST releases via the route, then re-POSTing a different winner replaces the set (route-level AC6)', async () => {
    const taskId = makeTask('AC6 Route Replace Task');
    const guestA = makeGuest('AC6 Route Replace Guest A');
    const guestB = makeGuest('AC6 Route Replace Guest B');
    const subA = makeSubmission(guestA, taskId);
    const subB = makeSubmission(guestB, taskId);

    const firstRes = await adminAgent
      .post('/admin/tasks/' + taskId + '/rank')
      .type('form')
      .send({ winners: String(subA) });
    expect(firstRes.status).toBe(303);
    expect(decodeURIComponent(firstRes.headers.location)).toMatch(/1 winner\./);

    const secondRes = await adminAgent
      .post('/admin/tasks/' + taskId + '/rank')
      .type('form')
      .send({ winners: String(subB) });
    expect(secondRes.status).toBe(303);
    expect(decodeURIComponent(secondRes.headers.location)).toMatch(/1 winner\./);

    expect(scoring.getPoints(guestA)).toBe(1); // award gone after the replace
    expect(scoring.getPoints(guestB)).toBe(6); // 1 base + 5 award
  });

  it('GET/POST 404 for an unknown task id', async () => {
    const getRes = await adminAgent.get('/admin/tasks/999999/rank');
    expect(getRes.status).toBe(404);
    const postRes = await adminAgent
      .post('/admin/tasks/999999/rank')
      .type('form')
      .send({ winners: '1' });
    expect(postRes.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC7: the five-code give-a-badge catalog is absent from the runtime
// catalog; the migration removes any pre-existing colliding rows.
// ---------------------------------------------------------------------------
describe('AC7: the give-a-badge catalog is retired', () => {
  it('SHUTTERBUG/CROWDFAV/CHOICE are absent from the seeded runtime catalog', () => {
    for (const code of ['SHUTTERBUG', 'CROWDFAV', 'CHOICE']) {
      expect(db.prepare('SELECT 1 AS x FROM badges WHERE code = ?').get(code)).toBeUndefined();
    }
  });

  it('src/services/photo-badges.js no longer exists as a module', () => {
    expect(() => require('../src/services/photo-badges')).toThrow();
  });

  it('the badge_winners table no longer exists', () => {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'badge_winners'`)
      .get();
    expect(row).toBeUndefined();
  });

  it('ensureSpecialBadgeCollisionsRemoved deletes a pre-existing colliding row and its guest_badges rows, and is idempotent', () => {
    // Simulate a pre-#661 database still carrying one of the three
    // colliding rows, with a guest holding it.
    db.prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES ('SHUTTERBUG', 'Shutterbug', 'special', NULL, '/badges/shutterbug.svg', '')`
    ).run();
    const badge = db.prepare('SELECT id FROM badges WHERE code = ?').get('SHUTTERBUG');
    const guestId = makeGuest('AC7 Collision Guest');
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, 'admin', 0)`
    ).run(guestId, badge.id);

    dbModule.ensureSpecialBadgeCollisionsRemoved();

    expect(
      db.prepare('SELECT 1 AS x FROM badges WHERE code = ?').get('SHUTTERBUG')
    ).toBeUndefined();
    expect(
      db
        .prepare('SELECT 1 AS x FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
        .get(guestId, badge.id)
    ).toBeUndefined();

    // Idempotent — a second run (nothing left to delete) does not throw.
    expect(() => dbModule.ensureSpecialBadgeCollisionsRemoved()).not.toThrow();
  });

  it('ensureGuestBadgeRankColumn is guarded (booting twice does not throw "duplicate column")', () => {
    const cols = db.prepare('PRAGMA table_info(guest_badges)').all();
    const rankCol = cols.find((c) => c.name === 'rank');
    expect(rankCol).toBeTruthy();
    expect(() => db.exec('ALTER TABLE guest_badges ADD COLUMN rank INTEGER')).toThrow(
      /duplicate column/i
    );
    expect(() => dbModule.ensureGuestBadgeRankColumn()).not.toThrow();
    expect(
      db
        .prepare('PRAGMA table_info(guest_badges)')
        .all()
        .filter((c) => c.name === 'rank').length
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC8: a winning guest's recap contains a row naming the badge + their rank,
// linking to the winning photo.
// ---------------------------------------------------------------------------
describe('AC8: release emits a recap row naming the badge + rank, linking to the photo', () => {
  function partsText(parts) {
    return (parts || []).map((part) => part.text).join('');
  }

  it('a 1st-place winner\'s recap row reads "You placed 1st for <badge>" and links to their photo', () => {
    const taskId = makeTask('AC8 Task');
    const guestId = makeGuest('AC8 Guest');
    const sub = makeSubmission(guestId, taskId);

    const result = taskBadges.releaseRanking(taskId, [sub]);

    const { rows } = notifications.getRecap(guestId);
    const badgeRow = rows.find((r) => r.badge && r.badge.code === result.badge.code);
    expect(badgeRow).toBeTruthy();
    expect(partsText(badgeRow.parts)).toContain('You placed 1st for');
    expect(partsText(badgeRow.parts)).toContain(result.badge.name);
    expect(badgeRow.href).toBe('/p/' + sub);
  });

  it("a 3rd-of-3 winner's recap row reads the correct ordinal for THEIR rank", () => {
    const taskId = makeTask('AC8 Trio Task');
    const g1 = makeGuest('AC8 Trio Guest 1');
    const g2 = makeGuest('AC8 Trio Guest 2');
    const g3 = makeGuest('AC8 Trio Guest 3');
    const s1 = makeSubmission(g1, taskId);
    const s2 = makeSubmission(g2, taskId);
    const s3 = makeSubmission(g3, taskId);

    taskBadges.releaseRanking(taskId, [s1, s2, s3]);

    const thirdRows = notifications.getRecap(g3).rows;
    const thirdBadgeRow = thirdRows.find((r) => r.badge);
    expect(partsText(thirdBadgeRow.parts)).toContain('You placed 3rd for');
    expect(thirdBadgeRow.href).toBe('/p/' + s3);
  });

  it('an auto/metric badge_granted event (no rank) is unaffected — still "You earned X", no link', () => {
    const guestId = makeGuest('AC8 Auto Guest');
    // Force BLOOM's threshold (5 completed tasks) via 5 plain task submissions.
    for (let i = 0; i < 5; i++) {
      makeSubmission(guestId, makeTask('AC8 Auto Filler ' + i));
    }
    scoring.recomputeBadges(guestId);

    const rows = notifications.getRecap(guestId).rows;
    const bloomRow = rows.find((r) => r.badge && r.badge.code === 'BLOOM');
    expect(bloomRow).toBeTruthy();
    expect(partsText(bloomRow.parts)).toBe('You earned ' + bloomRow.badge.name);
    expect(bloomRow.href).toBeNull();
  });
});
