// tests/profile-photo-task.test.js
// Issue #409 (original design) / #716 (owner rewrite, 2026-07-20): the
// hardcoded "Upload your profile photo" starter task pays +1. #716
// supersedes #409's one-time BANKED award — the point is now DERIVED live
// from guests.avatar_path: it pays while an avatar is set, leaves the total
// the moment the avatar is removed, and returns the moment one is set again.
// It is intentionally NOT a tasks/submissions row — the point flows through
// scoring.starterTaskContribution (read by both getPoints and leaderboard),
// so it never leaks into the public gallery/feed and never counts toward the
// completed-task badge thresholds (BLOOM/BOUQUET/GARDEN, which count
// submissions only).
//
// Both real avatar-setting call sites are covered:
//   - POST /join (signup) — the actual onboarding-time saveAvatar call site.
//   - POST /me/edit — profile edit, including the first-avatar and
//     replace-an-existing-avatar cases.
// Avatar removal goes through POST /me/avatar/delete (issue #528).
//
// AC1: Given a guest with no avatar, When they upload a profile photo, Then
//      their total gains +1 (getPoints and leaderboard agree).
// AC2: Given that guest, When they delete their profile photo, Then the +1
//      leaves the total and the tile returns to to-do showing "+1 pt".
// AC3: Given they re-upload, Then the +1 returns; repeating the cycle never
//      yields more than +1 at a time.
// AC4 (migration — pre-existing avatar_point_awarded=1 rows): covered
//      separately in tests/avatar-point-migration.test.js, which needs its
//      own standalone pre-#716 database shape (this file's loadApp() always
//      builds a FRESH, already-migrated database, so it cannot exercise a
//      real migration path — see that file's header for why it stands
//      alone).
// AC5 (docs-sync / green suite): covered by the repo-wide npm test/lint/
//      format:check run, not a unit assertion here.
//
// The tasks-page rendering assertions (tile placement, chip counts, "+1 pt"
// vs "Complete" label) that issue #409 originally proved are UNCHANGED by
// #716 — starterTaskContribution's done/total/done_count/todo_count shape is
// untouched, only its POINTS contribution became conditional on `done`. Full
// tile-rendering coverage for that stays where it already lived (this file's
// AC4 describe block below, renamed from the original file's AC4).
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// scoring (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const request = require('supertest');
const sharp = require('sharp');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so scoring's prepared statements bind to the
  // temp DATA_DIR/DB_PATH (see testApp.js "REQUIRE ORDER MATTERS").
  scoring = require('../src/services/scoring');
});

// A tiny valid JPEG, built with sharp (same pattern as
// tests/join-signup.test.js / tests/avatar-intake.test.js) so it passes
// photos.saveAvatar's real sharp pipeline instead of being rejected as
// undecodable.
function tinyJpeg(background) {
  return sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: background || { r: 200, g: 100, b: 50 },
    },
  })
    .jpeg()
    .toBuffer();
}

let guestSeq = 0;
function insertGuest(overrides) {
  guestSeq += 1;
  const g = Object.assign(
    {
      token: 'ppt-guest-' + guestSeq,
      name: 'Test Guest',
      avatar_path: null,
      bonus_points: 0,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO guests (token, name, avatar_path, bonus_points)
       VALUES (?, ?, ?, ?)`
    )
    .run(g.token, g.name, g.avatar_path, g.bonus_points).lastInsertRowid;
}

function guestRow(guestId) {
  return db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
}

// The leaderboard's own points field for one guest, so tests can assert
// getPoints and leaderboard AGREE (AC1) rather than only checking one path.
function leaderboardPoints(guestId) {
  const row = scoring.leaderboard().find((r) => r.id === guestId);
  return row ? row.points : undefined;
}

// A single real active task, distinct from the hardcoded starter tile, so
// AC4's ordering assertions have something real to be "first" ahead of.
function insertTask(title) {
  return db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run(title).lastInsertRowid;
}

function insertSubmission(guestId, taskId) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, 'p.jpg', 't.jpg').lastInsertRowid;
}

// ---------------------------------------------------------------------------
// AC1 — uploading a photo pays +1, at both call sites, agreeing across
// getPoints and leaderboard.
// ---------------------------------------------------------------------------
describe('AC1: uploading a profile photo pays +1 (derived, not banked)', () => {
  it('POST /join (signup) with an avatar: total gains +1, getPoints and leaderboard agree', async () => {
    const jpeg = await tinyJpeg();
    const res = await request(app)
      .post('/join')
      .field('name', 'Signup Avatar Guest')
      .field('contact', 'signup-avatar-716@example.com')
      .field('pin', '1357')
      .attach('avatar', jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);

    const row = db
      .prepare('SELECT * FROM guests WHERE contact = ?')
      .get('signup-avatar-716@example.com');
    expect(row).toBeTruthy();
    expect(row.avatar_path).toBeTruthy();
    expect(scoring.getPoints(row.id)).toBe(1);
    expect(leaderboardPoints(row.id)).toBe(1);
  });

  it('POST /me/edit with a first avatar: +1 lands on top of existing points, getPoints and leaderboard agree', async () => {
    const guestId = insertGuest({ token: 'edit-first-avatar', bonus_points: 3 });
    const before = scoring.getPoints(guestId);
    expect(before).toBe(3);
    expect(leaderboardPoints(guestId)).toBe(3);

    const agent = signInGuest(app, 'edit-first-avatar');
    const jpeg = await tinyJpeg({ r: 10, g: 20, b: 30 });
    const res = await agent
      .post('/me/edit')
      .field('name', 'Edit Avatar Guest')
      .attach('avatar', jpeg, { filename: 'b.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);
    const row = guestRow(guestId);
    expect(row.avatar_path).toBeTruthy();
    expect(scoring.getPoints(guestId)).toBe(before + 1);
    expect(leaderboardPoints(guestId)).toBe(before + 1);
  });

  it('replacing an already-set avatar via POST /me/edit still yields exactly +1, not +2', async () => {
    const guestId = insertGuest({
      token: 'edit-replace-avatar',
      avatar_path: 'existing-avatar.jpg',
      bonus_points: 5,
    });
    // The starter +1 is already part of "before" because avatar_path is set.
    const before = scoring.getPoints(guestId);
    expect(before).toBe(6);

    const agent = signInGuest(app, 'edit-replace-avatar');
    const jpeg = await tinyJpeg({ r: 1, g: 2, b: 3 });
    const res = await agent
      .post('/me/edit')
      .field('name', 'Replace Avatar Guest')
      .attach('avatar', jpeg, { filename: 'second.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);
    const row = guestRow(guestId);
    // The upload really replaced the file (not a no-op)...
    expect(row.avatar_path).not.toBe('existing-avatar.jpg');
    // ...but the starter contribution is still exactly one +1, not a second
    // one stacked on top — this is the assertion that would fail if the
    // derived term were mistakenly added again per upload instead of being
    // a presence check.
    expect(scoring.getPoints(guestId)).toBe(before);
    expect(leaderboardPoints(guestId)).toBe(before);
  });

  it('saving the edit form with no file attached (name/socials only) leaves points unchanged', async () => {
    const guestId = insertGuest({ token: 'edit-no-file', bonus_points: 2 });
    const before = scoring.getPoints(guestId);
    expect(before).toBe(2);

    const agent = signInGuest(app, 'edit-no-file');
    const res = await agent
      .post('/me/edit')
      .type('form')
      .send({ name: 'No File Guest', instagram: 'noavatar' });

    expect(res.status).toBe(302);
    const row = guestRow(guestId);
    expect(row.avatar_path).toBeNull();
    expect(scoring.getPoints(guestId)).toBe(before);
    expect(leaderboardPoints(guestId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC2 — deleting the avatar removes the +1 from the total and reverts the
// tile to to-do.
// ---------------------------------------------------------------------------
describe('AC2: deleting the avatar removes the +1', () => {
  it('POST /me/avatar/delete: the +1 leaves the total, and the tile shows to-do "+1 pt" again', async () => {
    const guestId = insertGuest({
      token: 'delete-removes-point',
      avatar_path: 'has-avatar.jpg',
      bonus_points: 2,
    });
    const before = scoring.getPoints(guestId);
    expect(before).toBe(3); // 2 bonus + 1 derived starter

    const agent = signInGuest(app, 'delete-removes-point');

    // Before removal: tile is Complete, in the done list.
    const doneBefore = await agent.get('/tasks?view=done');
    expect(doneBefore.text).toContain('Upload your profile photo');
    expect(doneBefore.text).toContain('<span class="task-points">Complete</span>');

    const delRes = await agent.post('/me/avatar/delete').type('form').send({});
    expect(delRes.status).toBe(302);

    expect(guestRow(guestId).avatar_path).toBeNull();
    expect(scoring.getPoints(guestId)).toBe(before - 1);
    expect(leaderboardPoints(guestId)).toBe(before - 1);

    // After removal: tile is back in the to-do list showing "+1 pt".
    const todoAfter = await agent.get('/tasks');
    expect(todoAfter.text).toContain('Upload your profile photo');
    expect(todoAfter.text).toContain('<span class="task-points">+1 pt</span>');
    const doneAfter = await agent.get('/tasks?view=done');
    expect(doneAfter.text).not.toContain('Upload your profile photo');
  });
});

// ---------------------------------------------------------------------------
// AC3 — re-uploading returns the +1; the upload/delete cycle never stacks
// more than +1 at a time, however many times it repeats.
// ---------------------------------------------------------------------------
describe('AC3: re-upload returns the +1, cycle never exceeds +1', () => {
  it('delete -> re-upload -> delete -> re-upload never yields more than +1 above baseline', async () => {
    const guestId = insertGuest({
      token: 'cycle-guest',
      avatar_path: 'first-avatar.jpg',
      bonus_points: 4,
    });
    const baseline = 4; // bonus_points only, avatar not yet counted below
    const agent = signInGuest(app, 'cycle-guest');

    // Starts with an avatar: +1 already applied.
    expect(scoring.getPoints(guestId)).toBe(baseline + 1);

    for (let cycle = 0; cycle < 3; cycle += 1) {
      // Remove: point leaves.
      const delRes = await agent.post('/me/avatar/delete').type('form').send({});
      expect(delRes.status).toBe(302);
      expect(scoring.getPoints(guestId)).toBe(baseline);
      expect(leaderboardPoints(guestId)).toBe(baseline);

      // Re-upload: point returns, never more than +1 above baseline.
      const jpeg = await tinyJpeg({ r: cycle, g: cycle + 1, b: cycle + 2 });
      const reuploadRes = await agent
        .post('/me/edit')
        .field('name', 'Cycle Guest')
        .attach('avatar', jpeg, { filename: `cycle-${cycle}.jpg`, contentType: 'image/jpeg' });
      expect(reuploadRes.status).toBe(302);
      expect(guestRow(guestId).avatar_path).toBeTruthy();
      expect(scoring.getPoints(guestId)).toBe(baseline + 1);
      expect(leaderboardPoints(guestId)).toBe(baseline + 1);
    }
  });
});

// ---------------------------------------------------------------------------
// Edge case: a guest id with no matching row (e.g. deleted between lookup
// and scoring call) must not throw and must contribute 0, not NaN or a
// crash — getPoints reads the guest row through the same stmtBonusPoints
// query starterTaskContribution's presence check depends on.
// ---------------------------------------------------------------------------
describe('edge case: getPoints on a non-existent guest id', () => {
  it('does not throw and returns 0', () => {
    expect(() => scoring.getPoints(999999)).not.toThrow();
    expect(scoring.getPoints(999999)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 (renamed from the original #409 file) — hardcoded task tile renders
// both states on the tasks page, and does NOT render on the guest home page.
// Untouched by #716: only the POINTS contribution became conditional on
// `done`, not this rendering/counting behavior.
// ---------------------------------------------------------------------------
describe('AC4: hardcoded starter task tile as a first row inside the list', () => {
  it('incomplete: tile is the first row in the to-do list, and is absent from the done view', async () => {
    insertGuest({ token: 'tasks-no-avatar' });
    insertTask('Real to-do task');
    const agent = signInGuest(app, 'tasks-no-avatar');

    const todoRes = await agent.get('/tasks');
    expect(todoRes.status).toBe(200);
    expect(todoRes.text).toContain('class="task-row task-todo"');
    expect(todoRes.text).toContain('<span class="task-points">+1 pt</span>');
    expect(todoRes.text).not.toContain('class="task-row task-done"');
    // First: the tile's title appears before the real task's title.
    const tileAt = todoRes.text.indexOf('Upload your profile photo');
    const realAt = todoRes.text.indexOf('Real to-do task');
    expect(tileAt).toBeGreaterThan(-1);
    expect(realAt).toBeGreaterThan(-1);
    expect(tileAt).toBeLessThan(realAt);

    // Absent from the done view — this guest hasn't completed it.
    const doneRes = await agent.get('/tasks?view=done');
    expect(doneRes.status).toBe(200);
    expect(doneRes.text).not.toContain('Upload your profile photo');
  });

  it('complete: tile is the first row in the done list, and is absent from the to-do view; avatar still renders on the home page', async () => {
    const guestId = insertGuest({
      token: 'tasks-with-avatar',
      avatar_path: 'has-avatar.jpg',
    });
    const realTaskId = insertTask('Real done task');
    insertSubmission(guestId, realTaskId);
    const agent = signInGuest(app, 'tasks-with-avatar');

    const doneRes = await agent.get('/tasks?view=done');
    expect(doneRes.status).toBe(200);
    expect(doneRes.text).toContain('class="task-row task-done"');
    expect(doneRes.text).toContain('<span class="task-points">Complete</span>');
    const tileAt = doneRes.text.indexOf('Upload your profile photo');
    const realAt = doneRes.text.indexOf('Real done task');
    expect(tileAt).toBeGreaterThan(-1);
    expect(realAt).toBeGreaterThan(-1);
    expect(tileAt).toBeLessThan(realAt);

    // Absent from the to-do view (the default) — already complete.
    const todoRes = await agent.get('/tasks');
    expect(todoRes.status).toBe(200);
    expect(todoRes.text).not.toContain('Upload your profile photo');

    // The existing avatar-render behavior still holds on the home page.
    const homeRes = await agent.get('/');
    expect(homeRes.status).toBe(200);
    expect(homeRes.text).toContain('avatar-img');
    expect(homeRes.text).toContain('/uploads/has-avatar.jpg');
  });

  // `tasks` is a global table — every guest sees every active task, scoped
  // only by which submissions belong to them (src/routes/guest.js GET
  // /tasks has no guest filter on the tasks query itself). The two counts
  // cases below each reset submissions/tasks first so this guest's chip
  // counts are computed from exactly the rows this test creates, not
  // whatever earlier `it` blocks in this file happened to insert.
  it('counts (incomplete guest): to-do chip includes the tile, done chip does not', async () => {
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM tasks').run();

    const incompleteId = insertGuest({ token: 'tasks-counts-incomplete' });
    insertTask('Counts to-do task (incomplete guest)');
    const doneTaskId = insertTask('Counts done task (incomplete guest)');
    insertSubmission(incompleteId, doneTaskId);

    const agent = signInGuest(app, 'tasks-counts-incomplete');
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);
    // 1 real to-do task + the tile = 2; 1 real done task, tile not counted.
    expect(res.text).toContain('To do · 2');
    expect(res.text).toContain('Done · 1');
  });

  it('counts (complete guest): done chip includes the tile, to-do chip does not', async () => {
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM tasks').run();

    const completeId = insertGuest({
      token: 'tasks-counts-complete',
      avatar_path: 'has-avatar.jpg',
    });
    insertTask('Counts to-do task (complete guest)');
    const doneTaskId = insertTask('Counts done task (complete guest)');
    insertSubmission(completeId, doneTaskId);

    const agent = signInGuest(app, 'tasks-counts-complete');
    const res = await agent.get('/tasks');
    expect(res.status).toBe(200);
    // 1 real to-do task, tile not counted; 1 real done task + the tile = 2.
    expect(res.text).toContain('To do · 1');
    expect(res.text).toContain('Done · 2');
  });

  it('does NOT render the starter tile on the guest home page (owner-redirected placement)', async () => {
    insertGuest({ token: 'home-no-tile' });
    const agent = signInGuest(app, 'home-no-tile');
    const res = await agent.get('/');

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Upload your profile photo');
  });
});
