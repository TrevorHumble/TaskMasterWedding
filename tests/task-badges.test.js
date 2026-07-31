// tests/task-badges.test.js
// Issue #483: task badges — model, upload slot, and award points/note/photo.
// Covers AC1-AC9 (behavioral) plus AC10 (the admin-tasks.ejs structural
// slot), following the loadApp()/direct-insert conventions used by
// tests/badge-engine.test.js and tests/per-photo-points.test.js.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let dbModule;
let scoring;
let taskBadges;
let adminAgent;

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  return db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run('tbtoken-' + guestSeq, name).lastInsertRowid;
}

function makeTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

let subSeq = 0;
function makeSubmission(guestId, taskId, takenDown = 0) {
  subSeq += 1;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, `p${subSeq}.jpg`, `t${subSeq}.jpg`, takenDown).lastInsertRowid;
}

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  dbModule = require('../src/db');
  scoring = require('../src/services/scoring');
  taskBadges = require('../src/services/task-badges');
  adminAgent = await makeAdminAgent(app);
});

// ---------------------------------------------------------------------------
// AC1: task carries its own badge, defaults to ribbon art
// ---------------------------------------------------------------------------
describe('AC1: task carries its own badge, defaults to ribbon art', () => {
  it('resolves a default custom row, then reflects an uploaded name/art on the SAME row', () => {
    const taskId = makeTask('Selfie with the cake');

    const initial = taskBadges.resolveTaskBadge(taskId);
    expect(initial.type).toBe('custom');
    expect(initial.art_path).toBe('/badges/default-ribbon.svg');
    expect(initial.task_id).toBe(taskId);

    taskBadges.setTaskBadge(taskId, { name: 'Golden Move', artPath: '/uploads/golden-move.jpg' });

    const updated = taskBadges.resolveTaskBadge(taskId);
    expect(updated.name).toBe('Golden Move');
    expect(updated.art_path).toBe('/uploads/golden-move.jpg');
    // Same row updated in place, not a second insert.
    expect(updated.id).toBe(initial.id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM badges WHERE task_id = ?').get(taskId).n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC2 & AC3: award carries points that reach the owner; note + earning photo
// stored on the award; removal drops the points back.
// ---------------------------------------------------------------------------
describe('AC2 & AC3: award points reach the owner; note + submission_id stored; removal drops points', () => {
  it('getPoints includes the award while held and drops it on removal', () => {
    const taskId = makeTask('Toast to the couple');
    const guestId = makeGuest('Guest AC2');
    const t2 = makeTask('AC2 filler task 2');
    const t3 = makeTask('AC2 filler task 3');

    // 3 points from 3 completed (visible) tasks, one of which is T itself.
    const sub42 = makeSubmission(guestId, taskId);
    makeSubmission(guestId, t2);
    makeSubmission(guestId, t3);
    expect(scoring.getPoints(guestId)).toBe(3);

    const badge = taskBadges.awardTaskBadge(taskId, sub42, { points: 5, note: 'The toast shot' });
    expect(badge).toBeTruthy();
    expect(scoring.getPoints(guestId)).toBe(8);

    const awardRow = db
      .prepare('SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(guestId, badge.id);
    expect(awardRow.note).toBe('The toast shot');
    expect(awardRow.submission_id).toBe(sub42);
    expect(awardRow.points).toBe(5);
    expect(awardRow.awarded_by).toBe('admin');

    taskBadges.removeTaskAward(taskId, sub42);
    expect(scoring.getPoints(guestId)).toBe(3);
    expect(
      db
        .prepare('SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
        .get(guestId, badge.id)
    ).toBeUndefined();
  });

  it('refuses (no row written) when the submission is missing or currently taken down', () => {
    const taskId = makeTask('Refused award task');
    const guestId = makeGuest('Guest AC2b');
    const takenDownSub = makeSubmission(guestId, taskId, 1);

    expect(taskBadges.awardTaskBadge(taskId, 999999, { points: 5 })).toBeNull();
    expect(taskBadges.awardTaskBadge(taskId, takenDownSub, { points: 5 })).toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM guest_badges WHERE guest_id = ?').get(guestId).n
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4: same task badge, two guests, different points, both exist at once.
// ---------------------------------------------------------------------------
describe('AC4: same task badge, two guests, different points', () => {
  it('both award rows exist at once, each with its own points', () => {
    const taskId = makeTask('Group photo (AC4)');
    const guestA = makeGuest('Guest AC4-A');
    const guestB = makeGuest('Guest AC4-B');
    const subA = makeSubmission(guestA, taskId);
    const subB = makeSubmission(guestB, taskId);

    const badgeA = taskBadges.awardTaskBadge(taskId, subA, { points: 5 });
    const badgeB = taskBadges.awardTaskBadge(taskId, subB, { points: 2 });
    expect(badgeA.id).toBe(badgeB.id); // same task -> same badge row

    const rowA = db
      .prepare('SELECT points FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(guestA, badgeA.id);
    const rowB = db
      .prepare('SELECT points FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(guestB, badgeB.id);
    expect(rowA.points).toBe(5);
    expect(rowB.points).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC5: one guest, two plain (un-customized) tasks, distinct non-colliding
// awards — proves distinct badge_ids never trip guest_badges' UNIQUE.
// ---------------------------------------------------------------------------
describe('AC5: one guest, two plain tasks, distinct non-colliding awards', () => {
  it('both award rows exist on distinct badge_ids; neither insert throws; total is 7', () => {
    const guestId = makeGuest('Guest AC5');
    const t1 = makeTask('Plain task AC5-1');
    const t2 = makeTask('Plain task AC5-2');
    const sub1 = makeSubmission(guestId, t1);
    const sub2 = makeSubmission(guestId, t2);

    const b1 = taskBadges.resolveTaskBadge(t1);
    const b2 = taskBadges.resolveTaskBadge(t2);
    expect(b1.art_path).toBe('/badges/default-ribbon.svg');
    expect(b2.art_path).toBe('/badges/default-ribbon.svg');
    expect(b1.id).not.toBe(b2.id);

    expect(() => {
      taskBadges.awardTaskBadge(t1, sub1, { points: 5 });
      taskBadges.awardTaskBadge(t2, sub2, { points: 2 });
    }).not.toThrow();

    const rows = db
      .prepare('SELECT badge_id, points FROM guest_badges WHERE guest_id = ?')
      .all(guestId);
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.badge_id)).size).toBe(2);
    expect(rows.reduce((sum, r) => sum + r.points, 0)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// AC6: award points follow the earning photo's visibility (getPoints AND
// leaderboard, with a fan-out guard on a two-photo guest).
// ---------------------------------------------------------------------------
describe('AC6: award points follow the earning photo visibility', () => {
  it('getPoints drops the award on takedown and re-adds it on restore', () => {
    const taskId = makeTask('Cake cutting (AC6)');
    const guestId = makeGuest('Guest AC6');
    const sub = makeSubmission(guestId, taskId);
    expect(scoring.getPoints(guestId)).toBe(1);

    taskBadges.awardTaskBadge(taskId, sub, { points: 5 });
    expect(scoring.getPoints(guestId)).toBe(6);

    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(sub);
    expect(scoring.getPoints(guestId)).toBe(0); // base point AND award both drop

    db.prepare('UPDATE submissions SET taken_down = 0 WHERE id = ?').run(sub);
    expect(scoring.getPoints(guestId)).toBe(6);
  });

  it('leaderboard() matches getPoints and does not fan out for a two-photo, one-award guest', () => {
    const taskId = makeTask('Bouquet toss (AC6 leaderboard)');
    const guestId = makeGuest('Guest AC6-LB');
    const otherTask = makeTask('AC6 leaderboard filler task');
    const subEarning = makeSubmission(guestId, taskId); // the awarded photo
    makeSubmission(guestId, otherTask); // a SECOND visible photo, no award

    taskBadges.awardTaskBadge(taskId, subEarning, { points: 5, note: 'nice' });

    // Two completed tasks (2 pts) + one award (5 pts) = 7. If the leaderboard
    // query joined guest_badges into its submissions-grouped aggregate
    // instead of using a correlated subquery, this guest's two submissions
    // would fan the join out 2x and the award sum would double to 10 (or the
    // photo_bonus/completed sums would double) — 7 exactly rules that out.
    expect(scoring.getPoints(guestId)).toBe(7);
    const row = scoring.leaderboard().find((r) => r.id === guestId);
    expect(row).toBeTruthy();
    expect(row.points).toBe(7);
    expect(row.completed).toBe(2);

    // Taking down the AWARDED photo drops both its base point and the award,
    // leaving only the other visible photo's base point (1) on both reads.
    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(subEarning);
    expect(scoring.getPoints(guestId)).toBe(1);
    const rowAfter = scoring.leaderboard().find((r) => r.id === guestId);
    expect(rowAfter.points).toBe(1);

    db.prepare('UPDATE submissions SET taken_down = 0 WHERE id = ?').run(subEarning);
    expect(scoring.getPoints(guestId)).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// AC7: system badges never carry award data.
// ---------------------------------------------------------------------------
describe('AC7: system badges never carry task-badge award data', () => {
  it('a system-granted BLOOM row has points=AUTO_METRIC_BADGE_POINTS, note IS NULL, submission_id IS NULL', () => {
    // Seed only the one catalog row this test needs, directly — avoids
    // pulling in scripts/seed.js's sample tasks (unnecessary here; see
    // tests/badge-engine.test.js for the fuller-catalog pattern).
    db.prepare(
      `INSERT OR IGNORE INTO badges (code, name, type, threshold, art_path, description)
       VALUES ('BLOOM', 'First Bloom', 'auto', 5, '/badges/bloom.svg', '')`
    ).run();

    const guestId = makeGuest('Guest AC7');
    for (let i = 0; i < 5; i++) {
      const t = makeTask('AC7 task ' + i);
      makeSubmission(guestId, t);
    }
    scoring.recomputeBadges(guestId);

    const row = db
      .prepare(
        `SELECT gb.* FROM guest_badges gb
           JOIN badges b ON b.id = gb.badge_id
          WHERE gb.guest_id = ? AND b.code = 'BLOOM'`
      )
      .get(guestId);
    expect(row).toBeTruthy();
    expect(row.awarded_by).toBe('system');
    // BLOOM is an auto badge — issue #709: it pays +1 (AUTO_METRIC_BADGE_POINTS)
    // for as long as the guest holds it, unlike a transferable/admin-special
    // grant (still points = 0). note/submission_id — the task-badge-specific
    // award metadata this describe block is really about — stay NULL either way:
    // stmtGrantBadge never sets them, only task-badges.awardTaskBadge does.
    expect(row.points).toBe(1);
    expect(row.note).toBeNull();
    expect(row.submission_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC8: reserved code prefix — createCustomBadge refuses a TASK- code.
// ---------------------------------------------------------------------------
describe('AC8: createCustomBadge refuses a reserved TASK- code', () => {
  it('returns null and writes no badges row', () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM badges').get().n;

    const result = scoring.createCustomBadge({
      code: 'TASK-999999',
      name: 'Sneaky',
      type: 'custom',
      artPath: '/badges/sneaky.svg',
    });

    expect(result).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM badges').get().n).toBe(before);
    expect(db.prepare('SELECT id FROM badges WHERE code = ?').get('TASK-999999')).toBeUndefined();
  });

  it('still creates a normal custom code that does not start with TASK-', () => {
    const badge = scoring.createCustomBadge({
      code: 'NOTATASKCODE',
      name: 'Regular Custom',
      type: 'custom',
      artPath: '/badges/regular.svg',
    });
    expect(badge).toBeTruthy();
    expect(badge.code).toBe('NOTATASKCODE');
  });
});

// ---------------------------------------------------------------------------
// Issue #811 AC2/AC3: victoryRankBySubmission() — the gallery tile's
// event-wide, one-query read of every currently-visible ranked award. This
// is the read side of #661's releaseRanking; tests/task-badge-rank-release.test.js
// covers the write path itself and is not duplicated here.
// ---------------------------------------------------------------------------
describe('issue #811: victoryRankBySubmission()', () => {
  it('a released ranking yields the expected submission_id -> { rank, badge } map; an unranked submission is absent', () => {
    const taskId = makeTask('Victory lookup task');
    const winner1 = makeGuest('Victory Lookup Winner 1');
    const winner2 = makeGuest('Victory Lookup Winner 2');
    const rank1Sub = makeSubmission(winner1, taskId);
    const rank2Sub = makeSubmission(winner2, taskId);

    // An unrelated, unranked submission on a DIFFERENT task — proves the
    // lookup only ever surfaces submissions that actually hold a released
    // rank, never every visible submission.
    const otherTaskId = makeTask('Victory lookup filler task');
    const unrankedGuest = makeGuest('Victory Lookup Unranked Guest');
    const unrankedSub = makeSubmission(unrankedGuest, otherTaskId);

    const released = taskBadges.releaseRanking(taskId, [rank1Sub, rank2Sub]);
    expect(released).toBeTruthy();

    const lookup = taskBadges.victoryRankBySubmission();
    expect(lookup[rank1Sub].rank).toBe(1);
    expect(lookup[rank2Sub].rank).toBe(2);
    expect(lookup[unrankedSub]).toBeUndefined();
  });

  it('a taken-down winning submission is excluded from the lookup, and returns once restored', () => {
    const taskId = makeTask('Victory lookup takedown task');
    const winner = makeGuest('Victory Lookup Takedown Winner');
    const winningSub = makeSubmission(winner, taskId);

    const released = taskBadges.releaseRanking(taskId, [winningSub]);
    expect(released).toBeTruthy();
    expect(taskBadges.victoryRankBySubmission()[winningSub].rank).toBe(1);

    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(winningSub);
    // The award row itself survives the takedown (issue #661 AC4) — only the
    // display-time lookup drops it, so a taken-down winner's medal comes off
    // the wall without losing the underlying award.
    expect(taskBadges.victoryRankBySubmission()[winningSub]).toBeUndefined();
    expect(
      db.prepare('SELECT rank FROM guest_badges WHERE submission_id = ?').get(winningSub).rank
    ).toBe(1);

    db.prepare('UPDATE submissions SET taken_down = 0 WHERE id = ?').run(winningSub);
    expect(taskBadges.victoryRankBySubmission()[winningSub].rank).toBe(1);
  });

  it('issue #893: the lookup carries the actual badge won — name + art_path — from the badges catalog row', () => {
    const taskId = makeTask('Victory lookup badge-art task');
    const winner = makeGuest('Victory Lookup Badge-Art Winner');
    const winningSub = makeSubmission(winner, taskId);

    // Customize the task's badge BEFORE releasing, so the lookup's joined
    // name/art_path can be asserted against a value distinct from the
    // lazily-inserted default ('Task Badge' / DEFAULT_RIBBON_ART_PATH) —
    // proving the join reads the customized badge row, not the lazily-inserted default.
    taskBadges.setTaskBadge(taskId, {
      name: 'Cake Smasher',
      artPath: '/badges/icons/cake.svg',
    });

    const released = taskBadges.releaseRanking(taskId, [winningSub]);
    expect(released).toBeTruthy();

    const entry = taskBadges.victoryRankBySubmission()[winningSub];
    expect(entry.rank).toBe(1);
    expect(entry.badge).toEqual({ name: 'Cake Smasher', art_path: '/badges/icons/cake.svg' });
  });
});

// ---------------------------------------------------------------------------
// Issue #892: releaseRanking accepts an EMPTY ordered list as a deliberate
// clear-all (amending #661's original 1-5-only floor) — "everyone posted
// junk" must never force the host to reward someone. The route-level
// coverage for the absent-vs-empty distinction and the parsed-short guard
// lives in tests/task-badge-rank-release.test.js; this covers the SERVICE
// write path itself: rows gone, no new events, idempotent re-clear, and the
// awarded marker staying set so the page reopens on the Results view.
// ---------------------------------------------------------------------------
describe('Issue #892: releaseRanking([]) is a deliberate clear-all, not a refusal', () => {
  function eventCount(guestId, badgeId) {
    return db
      .prepare(
        `SELECT COUNT(*) AS n FROM notification_events
          WHERE guest_id = ? AND badge_id = ? AND kind = 'badge_granted'`
      )
      .get(guestId, badgeId).n;
  }

  it('clearing a 2-winner ranking deletes both rows, marks the badge awarded, and fires no new events', () => {
    const taskId = makeTask('892 Clear Task');
    const guestA = makeGuest('892 Clear Guest A');
    const guestB = makeGuest('892 Clear Guest B');
    const subA = makeSubmission(guestA, taskId);
    const subB = makeSubmission(guestB, taskId);

    const first = taskBadges.releaseRanking(taskId, [subA, subB]);
    expect(first.winners).toBe(2);
    expect(eventCount(guestA, first.badge.id)).toBe(1);
    expect(eventCount(guestB, first.badge.id)).toBe(1);

    const cleared = taskBadges.releaseRanking(taskId, []);
    expect(cleared).toEqual({ badge: first.badge, winners: 0 });
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM guest_badges WHERE badge_id = ?').get(first.badge.id).n
    ).toBe(0);
    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(true); // stays released -> Results view

    // The clear itself is not a grant — no new badge_granted event for
    // either departing winner.
    expect(eventCount(guestA, first.badge.id)).toBe(1);
    expect(eventCount(guestB, first.badge.id)).toBe(1);
  });

  it('re-clearing an already-empty ranking is idempotent', () => {
    const taskId = makeTask('892 Idempotent Clear Task');
    const guestId = makeGuest('892 Idempotent Clear Guest');
    const sub = makeSubmission(guestId, taskId);

    taskBadges.releaseRanking(taskId, [sub]);
    const first = taskBadges.releaseRanking(taskId, []);
    expect(first.winners).toBe(0);

    const second = taskBadges.releaseRanking(taskId, []);
    expect(second.winners).toBe(0);
    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(true);
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM guest_badges WHERE badge_id = ?').get(first.badge.id).n
    ).toBe(0);
  });

  it('clearing a task never released before still marks it awarded (its badge row is lazily created)', () => {
    const taskId = makeTask('892 Clear Never Released Task');
    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(false);

    const result = taskBadges.releaseRanking(taskId, []);
    expect(result.winners).toBe(0);
    expect(taskBadges.isTaskBadgeAwarded(taskId)).toBe(true);
    expect(taskBadges.currentRanking(taskId)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AC9: migration is guarded — booting twice does not throw "duplicate
// column", same idempotency contract as db.js's other guarded migrations
// (see tests/per-photo-points.test.js AC1).
// ---------------------------------------------------------------------------
describe('AC9: migration is guarded', () => {
  it('badges.task_id and guest_badges.points/note/submission_id exist and the guards are idempotent', () => {
    const badgeCols = db.prepare('PRAGMA table_info(badges)').all();
    const taskIdCol = badgeCols.find((c) => c.name === 'task_id');
    expect(taskIdCol).toBeTruthy();

    const gbCols = db.prepare('PRAGMA table_info(guest_badges)').all();
    const pointsCol = gbCols.find((c) => c.name === 'points');
    const noteCol = gbCols.find((c) => c.name === 'note');
    const submissionIdCol = gbCols.find((c) => c.name === 'submission_id');
    expect(pointsCol).toBeTruthy();
    expect(pointsCol.notnull).toBe(1);
    expect(pointsCol.dflt_value).toBe('0');
    expect(noteCol).toBeTruthy();
    expect(submissionIdCol).toBeTruthy();

    // The guards are load-bearing: a NAKED add against the already-migrated
    // DB throws duplicate-column — this is what db.js would hit on a second
    // boot if it did not check PRAGMA table_info first.
    expect(() => db.exec('ALTER TABLE badges ADD COLUMN task_id INTEGER')).toThrow(
      /duplicate column/i
    );
    expect(() => db.exec('ALTER TABLE guest_badges ADD COLUMN points INTEGER')).toThrow(
      /duplicate column/i
    );

    // Calling db.js's REAL guards again (not an inline copy) is a safe no-op.
    expect(() => dbModule.ensureBadgeTaskIdColumn()).not.toThrow();
    expect(() => dbModule.ensureGuestBadgeAwardColumns()).not.toThrow();

    // And no duplicate columns were added.
    expect(
      db
        .prepare('PRAGMA table_info(badges)')
        .all()
        .filter((c) => c.name === 'task_id').length
    ).toBe(1);
    expect(
      db
        .prepare('PRAGMA table_info(guest_badges)')
        .all()
        .filter((c) => c.name === 'points').length
    ).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC10: task board shows the badge slot (structural).
//
// RETARGETED for issue #682's redesign: the admin task board is now
// `<li class="admin-task-card">` (not `<article class="task-admin-card">`),
// and "Choose badge"/"Change badge" are buttons inside the shared create-
// wizard/edit-popup dialogs (rendered once per page), not an inline per-task
// control — so those two assertions now check the PAGE, not the card.
// ---------------------------------------------------------------------------
describe('AC10: task board shows the badge slot', () => {
  it('a plain (default) task renders the empty-medallion state with "No badge" (#410: no upload input)', async () => {
    const taskId = makeTask('AC10 default task');

    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);

    const cardMatch = res.text.match(
      new RegExp(`<li class="admin-task-card[^"]*"\\s+id="task-${taskId}"[\\s\\S]*?</li>`)
    );
    expect(cardMatch).toBeTruthy();
    const card = cardMatch[0];

    expect(card).toMatch(/<span class="badge-medallion badge-medallion-empty"/);
    expect(card).toMatch(/No badge/);
    // #410: the file-upload badge-art control is gone everywhere — the icon
    // picker (a shared <dialog>, not an inline per-task control) is the only
    // source, and its own "Choose badge" trigger lives once per page.
    expect(card).not.toMatch(/type="file"/);
    expect(card).not.toMatch(/name="badge_art"/);
    expect(res.text).toContain('Choose badge');
  });

  it('a customized task renders its icon medallion and name', async () => {
    const taskId = makeTask('AC10 customized task');
    taskBadges.setTaskBadge(taskId, { name: 'Golden Move', artPath: '/badges/icons/favorite.svg' });

    const res = await adminAgent.get('/admin/tasks');
    const cardMatch = res.text.match(
      new RegExp(`<li class="admin-task-card[^"]*"\\s+id="task-${taskId}"[\\s\\S]*?</li>`)
    );
    const card = cardMatch[0];

    // #869: a custom-icon badge now renders as a CSS-masked <span> (the icon
    // supplied via --icon-src, recolored per-theme by --badge-icon-color),
    // not an <img src> baking the icon's fill into the served file — see
    // DESIGN.md's "Bundled badge-icon glyphs" ADR. The style value is built
    // by badgeIconMaskStyle (src/services/badge-icons.js, PR review finding
    // 3) and echoed via EJS's escaping `<%=`, so its quotes render as the
    // HTML entity `&#39;`, not a literal `'` — harmless to the browser (it
    // HTML-decodes the attribute before ever handing it to the CSS parser)
    // and required for finding 4's CSS-injection defense to hold together
    // with the HTML-attribute boundary.
    expect(card).toMatch(
      /<span class="badge-medallion-icon" style="--icon-src: url\(&#39;\/badges\/icons\/favorite\.svg&#39;\)"/
    );
    expect(card).toMatch(/Golden Move/);
    expect(card).not.toMatch(/name="badge_art"/);
    expect(res.text).toContain('Change badge');
  });
});

// ---------------------------------------------------------------------------
// #869 PR review, finding 5: the only existing test touching
// .badge-picker-glyph (tests/variant-stag.test.js) asserts the CSS RULE
// exists in theme.css, never that the picker GRID actually renders a masked
// span. Reverting badge-picker.ejs's grid glyph back to <img src> would keep
// every other test green while silently re-breaking the stag recolor for
// the picker surface specifically — this covers the rendered markup itself.
// ---------------------------------------------------------------------------
describe('#869 PR review finding 5: the badge-picker grid renders masked spans, not <img>', () => {
  it('GET /admin/tasks renders a known catalog icon as a masked span carrying --icon-src, inside the picker grid', async () => {
    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);

    // 'favorite' -> 'Heart' is src/services/badge-icons.js's first catalog
    // entry — real catalog data, not a hand-invented id.
    expect(res.text).toContain(
      '<span class="badge-picker-glyph" style="--icon-src: url(&#39;/badges/icons/favorite.svg&#39;)" role="img" aria-label="Heart"></span>'
    );
    // Regression guard: the pre-#869 grid rendered this exact icon as
    // `<img ... src="/badges/icons/favorite.svg" ...>` — the shape that
    // would reappear if the glyph ever reverted to an <img>.
    expect(res.text).not.toMatch(/<img[^>]*src="\/badges\/icons\/favorite\.svg"/);
  });
});

// ---------------------------------------------------------------------------
// Issue #903: badge-picker.js reads window.BadgeIconTags at init to build
// each cell's data-search attribute — that data only exists if
// badge-icon-tags.js has already run, so it must load BEFORE badge-picker.js.
// Both tags are `defer`, so document order IS execution order (deferred
// scripts run in source order just before DOMContentLoaded). Dropping this
// one <script> tag, or reordering it after badge-picker.js, would silently
// revert search to name-only with a fully green suite otherwise — nothing
// else asserts the wiring line, only the data file's own shape
// (tests/badge-icon-tags.test.js) and the filter logic in isolation
// (tests/badge-picker-script.test.js).
// ---------------------------------------------------------------------------
describe('issue #903: badge-icon-tags.js loads before badge-picker.js', () => {
  it('GET /admin/tasks includes both script tags, with badge-icon-tags.js first', async () => {
    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);

    const tagsIndex = res.text.indexOf('<script src="/js/badge-icon-tags.js"');
    const pickerIndex = res.text.indexOf('<script src="/js/badge-picker.js"');

    expect(tagsIndex).toBeGreaterThan(-1);
    expect(pickerIndex).toBeGreaterThan(-1);
    expect(tagsIndex).toBeLessThan(pickerIndex);
  });
});

// ---------------------------------------------------------------------------
// #869 PR review, finding 2: the masked-icon branch's accessibility must
// mirror what the retired <img alt=""> gave for free. An <img alt=""> is
// treated as decorative and skipped by assistive tech; a bare
// role="img" aria-label="" is NOT auto-demoted the same way and reads as an
// unnamed graphic. src/views/task.ejs:82 passes alt: '' to badge-art.ejs on
// purpose — the adjacent "<%= taskBadge.name %>" text already names the
// badge — so this is the exact call site that would regress if badge-art.ejs
// always emitted role="img"/aria-label regardless of whether alt is empty.
// ---------------------------------------------------------------------------
describe('#869 PR review finding 2: empty alt on the icon branch renders decorative, not an unnamed graphic', () => {
  it("task.ejs (alt: '') renders aria-hidden, no role/aria-label, for a custom-icon badge", async () => {
    const taskId = makeTask('Accessible icon task');
    taskBadges.setTaskBadge(taskId, {
      name: 'Golden Moment',
      artPath: '/badges/icons/favorite.svg',
    });

    // Insert directly with an own literal token, rather than reusing
    // makeGuest's shared guestSeq counter and re-deriving its token scheme
    // (fragile if another test's ordering ever changes) — this file's own
    // makeGuest/makeSubmission helpers do the same direct-insert pattern.
    const token = 'a11y-icon-token';
    db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, 'A11y Guest');
    const agent = signInGuest(app, token);

    const res = await agent.get(`/tasks/${taskId}`);
    expect(res.status).toBe(200);

    // The decorative shape: masked span carries the icon, but is invisible
    // to assistive tech (aria-hidden), and carries neither role nor
    // aria-label -- the adjacent badge name text is the only accessible name.
    expect(res.text).toContain(
      '<span class="badge-medallion-icon" style="--icon-src: url(&#39;/badges/icons/favorite.svg&#39;)" aria-hidden="true"></span>'
    );
    expect(res.text).not.toContain('role="img" aria-label=""');
    expect(res.text).not.toMatch(/badge-medallion-icon[^>]*role="img"/);
  });

  it('admin task board (no alt local -> defaults to badge.name) still renders role="img" + aria-label for the SAME icon', async () => {
    // Regression guard the other way: a NON-empty alt must keep the
    // accessible-name shape, so a future fix cannot "solve" finding 2 by
    // always going decorative.
    const taskId = makeTask('Named icon task');
    taskBadges.setTaskBadge(taskId, {
      name: 'Golden Moment',
      artPath: '/badges/icons/favorite.svg',
    });

    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);
    expect(res.text).toContain(
      '<span class="badge-medallion-icon" style="--icon-src: url(&#39;/badges/icons/favorite.svg&#39;)" role="img" aria-label="Golden Moment"></span>'
    );
  });
});
