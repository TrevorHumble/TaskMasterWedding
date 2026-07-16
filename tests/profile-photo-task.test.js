// tests/profile-photo-task.test.js
// Issue #409: a hardcoded starter task, "Upload your profile photo", awards a
// one-time bonus point (scoring.awardProfilePhotoPoint) the first time a
// guest sets an avatar. It is intentionally NOT a tasks/submissions row — the
// point flows through addBonusPoints (the single scoring authority) so it
// never leaks into the public gallery/feed and never counts toward the
// completed-task badge thresholds (BLOOM/BOUQUET/GARDEN, which count
// submissions only — see issue #409's "Deliberate scope call for the
// reviewer").
//
// Both real avatar-setting call sites are covered:
//   - POST /join (signup) — the actual onboarding-time saveAvatar call site.
//     (POST /onboard, named in the issue's background, is dead code retired
//     by issue #244 — it only redirects to /join and never calls saveAvatar,
//     so hooking it would award nothing. See src/routes/auth.js's #409 note
//     on that route.)
//   - POST /me/edit — profile edit, including the first-avatar and
//     replace-an-existing-avatar cases.
//
// AC1: first avatar save awards exactly +1 point and flips
//      guests.avatar_point_awarded to 1, at both call sites.
// AC2: a guest who already earned the point does not earn it again when
//      they replace their avatar via POST /me/edit — even across many
//      replacements.
// AC3: saving the edit form with no file attached (name/socials only)
//      awards nothing and leaves avatar_point_awarded at 0.
// AC4 (re-amended by the owner's second 2026-07-14 visual-loop pass): the
//      tasks page (GET /tasks) renders the literal "Upload your profile
//      photo" tile as an ordinary FIRST row INSIDE the to-do or done list —
//      not a section above the filters. Incomplete, it is first in the
//      to-do list and absent from the done view; complete, it is first in
//      the done list and absent from the to-do view. Either way it is
//      folded into the todoCount/doneCount/totalCount chips next to those
//      lists. The guest home page (GET /) does NOT render it — the owner
//      moved the tile off the home/profile surface into the task list
//      during the first 2026-07-14 visual-approval pass.
// AC5: guests.avatar_path is populated and the guest's own home page still
//      renders the avatar image (existing behavior).
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
      avatar_point_awarded: 0,
      bonus_points: 0,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO guests (token, name, avatar_path, avatar_point_awarded, bonus_points)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(g.token, g.name, g.avatar_path, g.avatar_point_awarded, g.bonus_points).lastInsertRowid;
}

function guestRow(guestId) {
  return db.prepare('SELECT * FROM guests WHERE id = ?').get(guestId);
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
// AC1 — one-time award on first avatar save, at both call sites.
// ---------------------------------------------------------------------------
describe('AC1: first avatar save awards exactly +1 point', () => {
  it('POST /join (signup) with an avatar awards the point and sets avatar_path (AC5)', async () => {
    const jpeg = await tinyJpeg();
    const res = await request(app)
      .post('/join')
      .field('name', 'Signup Avatar Guest')
      .field('contact', 'signup-avatar-409@example.com')
      .field('pin', '1357')
      .attach('avatar', jpeg, { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);

    const row = db
      .prepare('SELECT * FROM guests WHERE contact = ?')
      .get('signup-avatar-409@example.com');
    expect(row).toBeTruthy();
    expect(row.avatar_path).toBeTruthy(); // AC5: avatar_path populated
    expect(row.avatar_point_awarded).toBe(1);
    expect(scoring.getPoints(row.id)).toBe(1); // P(0) + 1
  });

  it('POST /me/edit with a first avatar awards the point on top of existing points', async () => {
    const guestId = insertGuest({ token: 'edit-first-avatar', bonus_points: 3 });
    const before = scoring.getPoints(guestId);
    expect(before).toBe(3);

    const agent = signInGuest(app, 'edit-first-avatar');
    const jpeg = await tinyJpeg({ r: 10, g: 20, b: 30 });
    const res = await agent
      .post('/me/edit')
      .field('name', 'Edit Avatar Guest')
      .attach('avatar', jpeg, { filename: 'b.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(302);
    const row = guestRow(guestId);
    expect(row.avatar_path).toBeTruthy();
    expect(row.avatar_point_awarded).toBe(1);
    expect(scoring.getPoints(guestId)).toBe(before + 1);
  });
});

// ---------------------------------------------------------------------------
// AC2 — no double award on replacement, even across delete-then-re-upload
// (avatar_point_awarded never resets once set, independent of avatar_path).
// ---------------------------------------------------------------------------
describe('AC2: no double award on replacement', () => {
  it('replacing an already-awarded avatar via POST /me/edit leaves points unchanged', async () => {
    // bonus_points already includes the point banked when this guest first
    // earned it — the fixture simulates "already awarded" directly, matching
    // AC2's Given.
    const guestId = insertGuest({
      token: 'edit-replace-avatar',
      avatar_path: 'existing-avatar.jpg',
      avatar_point_awarded: 1,
      bonus_points: 5,
    });
    const before = scoring.getPoints(guestId);
    expect(before).toBe(5);

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
    // ...but the one-time point guard held: still awarded once, points
    // unchanged. This is the assertion that would fail if the guard were
    // removed (points would read 6, not 5).
    expect(row.avatar_point_awarded).toBe(1);
    expect(scoring.getPoints(guestId)).toBe(before);
  });

  it('awardProfilePhotoPoint itself is a no-op on a second call for the same guest', () => {
    const guestId = insertGuest({ token: 'award-twice-direct', bonus_points: 0 });
    expect(scoring.awardProfilePhotoPoint(guestId)).toBe(true);
    expect(scoring.getPoints(guestId)).toBe(1);
    // Second call: already awarded, no-op.
    expect(scoring.awardProfilePhotoPoint(guestId)).toBe(false);
    expect(scoring.getPoints(guestId)).toBe(1);
  });

  it('a guest id that does not exist returns false and does not throw (edge case)', () => {
    expect(() => scoring.awardProfilePhotoPoint(999999)).not.toThrow();
    expect(scoring.awardProfilePhotoPoint(999999)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AC3 — no award without a photo.
// ---------------------------------------------------------------------------
describe('AC3: no award without a photo', () => {
  it('saving the edit form with no file attached (name/socials only) awards nothing', async () => {
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
    expect(row.avatar_point_awarded).toBe(0);
    expect(scoring.getPoints(guestId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// AC4 — hardcoded task tile renders both states on the tasks page, and does
// NOT render on the guest home page.
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

  it('complete: tile is the first row in the done list, and is absent from the to-do view; avatar still renders on the home page (AC5)', async () => {
    const guestId = insertGuest({
      token: 'tasks-with-avatar',
      avatar_path: 'has-avatar.jpg',
      avatar_point_awarded: 1,
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

    // AC5: the existing avatar-render behavior still holds on the home page.
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
      avatar_point_awarded: 1,
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
