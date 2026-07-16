// tests/badge-detail-page.test.js
// Issue #488 — GET /badge/:code. Two rendered shapes keyed on badge kind:
//   - system  (auto/metric/transferable): shared catalog description + a
//     plain holder list, no per-award data.
//   - Task Master (custom): the badge's own description, then one row per
//     award with that award's points/note, and a photo thumb only while the
//     earning submission is still visible.
//
// REQUIRE ORDER: config/db/app must only be required AFTER loadApp() sets
// DATA_DIR/DB_PATH (same pattern as tests/badge-frontend.test.js).
//
// SIGN-IN IS REQUIRED FOR EVERY REQUEST, even though src/routes/community.js
// itself never wraps GET /badge/:code in requireGuest: src/routes/guest.js
// mounts at '/' BEFORE community.js and applies `router.use(requireGuest)`
// with no path filter (src/routes/guest.js:67), so it runs ahead of every
// community.js route including this one, redirecting an anonymous request to
// /join before community.js's own handler — and thus before its 404 logic —
// ever runs. tests/community-branches.test.js documents the same composed
// behavior for GET /u/:guestId. AC5's "404" therefore has to be observed
// through a signed-in agent, exactly like every other assertion here.
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let taskBadges;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  // src/db.js's boot path already seeds the badge catalog (COMPLETIONIST
  // included) via ensureBadgeCatalog() — no scripts/seed.js require needed.
  taskBadges = require('../src/services/task-badges');
});

let guestSeq = 0;
function makeGuest(name) {
  guestSeq += 1;
  const token = `badge-detail-${guestSeq}`;
  const id = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(token, name).lastInsertRowid;
  return { id, token };
}

let taskSeq = 0;
function makeTask() {
  taskSeq += 1;
  return db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(`Badge detail fixture task ${taskSeq}`).lastInsertRowid;
}

let subSeq = 0;
function submit(guestId, taskId) {
  subSeq += 1;
  const info = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, `badge-detail-${subSeq}.jpg`, `badge-detail-${subSeq}-t.jpg`);
  return info.lastInsertRowid;
}

function takeDown(submissionId) {
  db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(submissionId);
}

function signIn(token) {
  return signInGuest(app, token);
}

describe('AC1: system badge (COMPLETIONIST) shows the shared description + holders', () => {
  it('holds no per-award note markup and lists every holder', async () => {
    const priya = makeGuest('Priya');
    const marcus = makeGuest('Marcus');

    const completionist = db
      .prepare('SELECT id, description FROM badges WHERE code = ?')
      .get('COMPLETIONIST');

    // A 'metric' badge is never admin-awardable (scoring.js's
    // ADMIN_AWARDABLE_TYPES excludes it) — grant it the same way
    // recomputeBadges' stmtGrantBadge does, directly against guest_badges,
    // matching how every system badge actually gets held in production.
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')`
    ).run(priya.id, completionist.id);
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')`
    ).run(marcus.id, completionist.id);

    const agent = await signIn(priya.token);
    const res = await agent.get('/badge/COMPLETIONIST');

    expect(res.status).toBe(200);
    expect(res.text).toContain(completionist.description);
    expect(res.text).toContain('Priya');
    expect(res.text).toContain('Marcus');
    // AC6 in the system-badge branch: holder names are wrapped in a profile
    // link, not just plain text — a regression that dropped the holder-row
    // `<a href="/u/...">` wrapper must fail here, not slip through.
    expect(res.text).toContain(`href="/u/${priya.id}">Priya<`);
    expect(res.text).toContain(`href="/u/${marcus.id}">Marcus<`);
    // Structural: the Task Master award-row markup (points/note) never
    // appears in the system-badge render — only the plain holder-list markup.
    expect(res.text).not.toContain('award-row');
    expect(res.text).toContain('holder-row');
  });
});

describe('Admin-created custom badge (type=custom, no task_id) renders the holder list', () => {
  it('does not render the Task Master award-row shape for a non-task custom badge', async () => {
    // POST /admin/badges (src/routes/admin.js) mints a host-defined custom
    // badge with type='custom' and task_id NULL — NOT a task's own badge. It
    // carries no per-award points/note/photo, so it must render the plain
    // holder list, not empty award rows. This is exactly the case a
    // `type === 'custom'` discriminant would get wrong; the route keys on
    // task_id instead. Insert one directly (same columns createCustomBadge
    // writes: no task_id) and award it to a guest.
    const dancer = makeGuest('Dancer');
    db.prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES ('MVPDANCER', 'MVP Dancer', 'custom', NULL, '/badges/default-ribbon.svg', 'Best on the floor.')`
    ).run();
    const badge = db.prepare('SELECT id FROM badges WHERE code = ?').get('MVPDANCER');
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'admin')`
    ).run(dancer.id, badge.id);

    const agent = await signIn(dancer.token);
    const res = await agent.get('/badge/MVPDANCER');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Best on the floor.');
    expect(res.text).toContain(`href="/u/${dancer.id}">Dancer<`);
    // The decisive assertion: a non-task custom badge renders the holder list,
    // never the award-row (points/note) shape.
    expect(res.text).toContain('holder-row');
    expect(res.text).not.toContain('award-row');
  });
});

describe('AC2-AC4, AC6: Task Master badge (GOLDENMOVE) shows per-award note/points/photo', () => {
  it('renders each award, links the earning photo only while visible, and links names to profiles', async () => {
    const priya = makeGuest('Priya');
    const marcus = makeGuest('Marcus');
    const taskId = makeTask();

    // A task's own badge, hand-named the way an admin customizing a task's
    // badge would (src/services/task-badges.js's setTaskBadge changes name/
    // art but never the code — GOLDENMOVE here stands in for whatever code
    // that task's badge row already carries; the route/query never assume a
    // 'TASK-<id>' shape, only that type === 'custom').
    const goldenMoveTaskBadgeId = db
      .prepare(
        `INSERT INTO badges (code, name, type, threshold, art_path, description, task_id)
         VALUES ('GOLDENMOVE', 'Golden Move', 'custom', NULL, '/badges/default-ribbon.svg', 'Best move on the floor.', ?)`
      )
      .run(taskId).lastInsertRowid;

    const priyaSubmissionId = submit(priya.id, taskId);
    const marcusSubmissionId = submit(marcus.id, taskId);

    // Real production write path (task-badges.awardTaskBadge) for both
    // awards — resolveTaskBadge finds the GOLDENMOVE row above by task_id
    // rather than lazily inserting a second one.
    const priyaAward = taskBadges.awardTaskBadge(taskId, priyaSubmissionId, {
      points: 5,
      note: 'The toast',
    });
    expect(priyaAward.id).toBe(goldenMoveTaskBadgeId);
    const marcusAward = taskBadges.awardTaskBadge(taskId, marcusSubmissionId, {
      points: 3,
      note: 'First dance',
    });
    expect(marcusAward.id).toBe(goldenMoveTaskBadgeId);

    // AC4: Marcus's earning photo is taken down AFTER the award, mirroring
    // admin moderation — the award's note/points must still render, only the
    // thumb/href must disappear (the alternative to "submission_id NULL" the
    // AC names; both collapse to the same LEFT JOIN miss in badgeWithHolders).
    takeDown(marcusSubmissionId);

    const agent = await signIn(priya.token);
    const res = await agent.get('/badge/GOLDENMOVE');

    expect(res.status).toBe(200);

    // AC2: names, points, notes.
    expect(res.text).toContain('Priya');
    expect(res.text).toContain('+5 pts');
    expect(res.text).toContain('The toast');
    expect(res.text).toContain('Marcus');
    expect(res.text).toContain('+3 pts');
    expect(res.text).toContain('First dance');

    // AC3: Priya's visible earning photo links to its exact feed anchor.
    expect(res.text).toContain(`href="/feed?from=${priyaSubmissionId}#photo-${priyaSubmissionId}"`);

    // AC4: Marcus's taken-down photo contributes no feed href for its id —
    // his name/note/points above already proved his row still rendered.
    expect(res.text).not.toContain(
      `href="/feed?from=${marcusSubmissionId}#photo-${marcusSubmissionId}"`
    );

    // AC6: both names are wrapped in a link to their public profile.
    expect(res.text).toContain(`href="/u/${priya.id}">Priya<`);
    expect(res.text).toContain(`href="/u/${marcus.id}">Marcus<`);
  });
});

describe('AC5: unknown badge code 404s', () => {
  it('GET /badge/NOPE returns 404', async () => {
    const guest = makeGuest('AC5 Guest');
    const agent = await signIn(guest.token);
    const res = await agent.get('/badge/NOPE');
    expect(res.status).toBe(404);
  });
});
