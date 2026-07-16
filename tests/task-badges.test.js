// tests/task-badges.test.js
// Issue #483: task badges — model, upload slot, and award points/note/photo.
// Covers AC1-AC9 (behavioral) plus AC10 (the admin-tasks.ejs structural
// slot), following the loadApp()/direct-insert conventions used by
// tests/badge-engine.test.js and tests/per-photo-points.test.js.
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
describe('AC7: system badges never carry award data', () => {
  it('a system-granted BLOOM row has points=0, note IS NULL, submission_id IS NULL', () => {
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
    expect(row.points).toBe(0);
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
// ---------------------------------------------------------------------------
describe('AC10: task board shows the badge slot', () => {
  it('a plain (default) task renders task-badge-row with an img and an upload file input', async () => {
    const taskId = makeTask('AC10 default task');

    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);

    const cardMatch = res.text.match(
      new RegExp(`<article class="task-admin-card[^"]*" id="task-${taskId}">[\\s\\S]*?</article>`)
    );
    expect(cardMatch).toBeTruthy();
    const card = cardMatch[0];

    expect(card).toMatch(/<div class="task-badge-row">/);
    expect(card).toMatch(/<img class="badge-art"[^>]*src="\/badges\/default-ribbon\.svg"/);
    expect(card).toMatch(/type="file"[^>]*name="badge_art"/);
  });

  it('a customized task renders its own art and OMITS the upload control', async () => {
    const taskId = makeTask('AC10 customized task');
    taskBadges.setTaskBadge(taskId, { name: 'Golden Move', artPath: '/uploads/ac10-custom.jpg' });

    const res = await adminAgent.get('/admin/tasks');
    const cardMatch = res.text.match(
      new RegExp(`<article class="task-admin-card[^"]*" id="task-${taskId}">[\\s\\S]*?</article>`)
    );
    const card = cardMatch[0];

    expect(card).toMatch(/<div class="task-badge-row">/);
    expect(card).toMatch(/src="\/uploads\/ac10-custom\.jpg"/);
    expect(card).not.toMatch(/name="badge_art"/);
  });
});
