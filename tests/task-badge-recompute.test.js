// tests/task-badge-recompute.test.js
// Issue #701: the Completionist badge went stale when the admin changed the
// active-task set (add/hide/un-hide/delete a task) because nothing recomputed
// badges outside the per-guest submission-change seam. These tests prove the
// FIX lives in the route, not in some helper the test calls itself: every
// assertion below hits an admin route through the agent and checks the
// resulting guest_badges state WITHOUT ever calling scoring.recompute* in the
// test body (issue implementation plan step 3) — a precondition of "this
// guest already holds COMPLETIONIST" is built with a direct guest_badges
// insert, not by asking the engine to compute it first.
//
// Conventions follow tests/admin-tasks-crud.test.js (loadApp/makeAdminAgent,
// route-level DB-state assertions) and tests/badge-engine.test.js
// (deactivating unrelated seeded tasks so "covers every active task" is
// unambiguous).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let db;
let adminAgent;
let completionistBadgeId;
let scoring;

let guestTokenSeq = 0;
function makeGuest(name) {
  guestTokenSeq += 1;
  const token = `task-recompute-${guestTokenSeq}`;
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, name)
    .lastInsertRowid;
}

function makeTask(title, isActive = 1) {
  return db
    .prepare('INSERT INTO tasks (title, special_mode) VALUES (?, ?)')
    .run(title, isActive ? 'none' : 'hidden').lastInsertRowid;
}

let photoSeq = 0;
function submit(guestId, taskId) {
  photoSeq += 1;
  const photo = `trp${photoSeq}.jpg`;
  const thumb = `trt${photoSeq}.jpg`;
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  ).run(guestId, taskId, photo, thumb);
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

// Directly grants COMPLETIONIST to a guest via a raw guest_badges insert —
// deliberately NOT scoring.recomputeBadges — so a test can set up the
// "guest already holds it" precondition without the test itself calling any
// recompute* function (the whole point of this suite is proving the ROUTE's
// call to recomputeAfterTaskChange is what strips/grants the badge).
function grantCompletionistDirect(guestId) {
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')`
  ).run(guestId, completionistBadgeId);
}

beforeAll(async () => {
  const loaded = loadApp();
  db = loaded.db;
  adminAgent = await makeAdminAgent(loaded.app);
  // Required only for the spy in the "worth-only edit" test below (to prove
  // the conditional skip, not to call recompute* directly — see the file
  // comment above about never calling scoring.recompute* in a test body to
  // FABRICATE state, which this does not do).
  scoring = require('../src/services/scoring');
  // Seed the real catalog so COMPLETIONIST/EARLYBIRD exist, mirroring
  // tests/badge-engine.test.js.
  require('../scripts/seed.js');
  // The seed script's own sample tasks would make "covers every active task"
  // ambiguous for every scenario below — deactivate them so each test's own
  // makeTask() calls are the only active tasks in play.
  db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
  completionistBadgeId = db.prepare('SELECT id FROM badges WHERE code = ?').get('COMPLETIONIST').id;
});

describe('AC1: POST /admin/tasks strips a now-stale Completionist', () => {
  it('adding a new active task the guest has not covered revokes COMPLETIONIST', async () => {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const taskA = makeTask('AC1 Task A', 1);
    const guest = makeGuest('AC1 Guest');
    submit(guest, taskA);
    // Precondition: guest covers every currently-active task (just taskA).
    grantCompletionistDirect(guest);
    expect(heldCodes(guest)).toContain('COMPLETIONIST');

    // Issue #682: badge is now required server-side on every POST /admin/tasks.
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'AC1 Task B — new', badge_icon: 'favorite' });

    expect(heldCodes(guest)).not.toContain('COMPLETIONIST');
  });
});

describe('AC2: POST /admin/tasks/:id/active (un-hide) strips a now-stale Completionist', () => {
  it('un-hiding a task the guest has not covered revokes COMPLETIONIST', async () => {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const taskA = makeTask('AC2 Task A', 1);
    const hiddenTask = makeTask('AC2 Hidden Task', 0);
    const guest = makeGuest('AC2 Guest');
    submit(guest, taskA);
    // Guest covers the only active task (taskA); hiddenTask is special_mode
    // 'hidden' and uncovered, so it does not count yet.
    grantCompletionistDirect(guest);
    expect(heldCodes(guest)).toContain('COMPLETIONIST');

    await adminAgent.post(`/admin/tasks/${hiddenTask}/active`).type('form').send({});

    expect(
      db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(hiddenTask).special_mode
    ).toBe('none');
    expect(heldCodes(guest)).not.toContain('COMPLETIONIST');
  });
});

describe('AC3: POST /admin/tasks/:id/active (hide) awards a newly-earned Completionist', () => {
  it('hiding the one uncovered task grants COMPLETIONIST', async () => {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const taskA = makeTask('AC3 Task A', 1);
    const uncoveredTask = makeTask('AC3 Uncovered Task', 1);
    const guest = makeGuest('AC3 Guest');
    submit(guest, taskA);
    // Guest covers taskA but not uncoveredTask — does not hold it yet.
    expect(heldCodes(guest)).not.toContain('COMPLETIONIST');

    await adminAgent.post(`/admin/tasks/${uncoveredTask}/active`).type('form').send({});

    expect(
      db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(uncoveredTask).special_mode
    ).toBe('hidden');
    expect(heldCodes(guest)).toContain('COMPLETIONIST');
  });
});

describe('AC4: POST /admin/tasks/:id/delete awards a newly-earned Completionist', () => {
  it('deleting the one uncovered task grants COMPLETIONIST', async () => {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const taskA = makeTask('AC4 Task A', 1);
    const uncoveredTask = makeTask('AC4 Uncovered Task', 1);
    const guest = makeGuest('AC4 Guest');
    submit(guest, taskA);
    expect(heldCodes(guest)).not.toContain('COMPLETIONIST');

    await adminAgent.post(`/admin/tasks/${uncoveredTask}/delete`).type('form').send({});

    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(uncoveredTask)).toBeUndefined();
    expect(heldCodes(guest)).toContain('COMPLETIONIST');
  });
});

describe('AC5: admin-awarded badges are never touched, and the recompute is idempotent', () => {
  it('an admin-awarded special badge survives all three task-set routes', async () => {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const guest = makeGuest('AC5 Guest');
    const earlybird = db.prepare('SELECT id FROM badges WHERE code = ?').get('EARLYBIRD');
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'admin')`
    ).run(guest, earlybird.id);
    expect(heldCodes(guest)).toContain('EARLYBIRD');

    // Fire each of the three task-set routes once.
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'AC5 Add', badge_icon: 'favorite' });
    const toggleTask = makeTask('AC5 Toggle Task', 1);
    await adminAgent.post(`/admin/tasks/${toggleTask}/active`).type('form').send({});
    const deleteTask = makeTask('AC5 Delete Task', 1);
    await adminAgent.post(`/admin/tasks/${deleteTask}/delete`).type('form').send({});

    expect(heldCodes(guest)).toContain('EARLYBIRD');
    const row = db
      .prepare(`SELECT awarded_by FROM guest_badges WHERE guest_id = ? AND badge_id = ?`)
      .get(guest, earlybird.id);
    expect(row.awarded_by).toBe('admin');
  });

  it('a second identical trigger of the delete route leaves the full guest_badges set unchanged', async () => {
    // POST /admin/tasks/:id/delete does not check the task exists first
    // (src/routes/admin.js) — deleting an id a SECOND time matches zero rows
    // (the task, its submissions, and its badge art are already gone) but
    // still runs recomputeAfterTaskChange() unconditionally afterward. That
    // makes it a genuine "identical trigger": the active-task set is
    // provably unchanged between the two calls (nothing left to delete the
    // second time), so the recompute's own idempotence is what is under
    // test here, not a route that inherently mutates data on every call
    // (unlike POST /admin/tasks, which always inserts a new row).
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const guest = makeGuest('AC5 Idempotent Guest');
    const covered = makeTask('AC5 Idempotent Covered', 1);
    submit(guest, covered);
    const toDelete = makeTask('AC5 Idempotent To Delete', 1);
    // Guest does not cover toDelete yet, so it does not hold COMPLETIONIST.
    expect(heldCodes(guest)).not.toContain('COMPLETIONIST');

    await adminAgent.post(`/admin/tasks/${toDelete}/delete`).type('form').send({});
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(toDelete)).toBeUndefined();
    // toDelete is gone, guest now covers every remaining active task.
    expect(heldCodes(guest)).toContain('COMPLETIONIST');

    const beforeSecondRun = db
      .prepare(
        'SELECT guest_id, badge_id, awarded_by FROM guest_badges ORDER BY guest_id, badge_id'
      )
      .all();

    const res = await adminAgent.post(`/admin/tasks/${toDelete}/delete`).type('form').send({});
    expect(res.status).toBe(303);

    const afterSecondRun = db
      .prepare(
        'SELECT guest_id, badge_id, awarded_by FROM guest_badges ORDER BY guest_id, badge_id'
      )
      .all();
    expect(afterSecondRun).toEqual(beforeSecondRun);
  });
});

// ---------------------------------------------------------------------------
// Issue #682: the NEW single edit-popup save (POST /admin/tasks/:id/edit) now
// also writes special_mode (folded into the same submit as title/description/
// worth/badge). These tests mirror AC2/AC3 above but drive the membership
// change through the COMBINED edit route instead of the old dedicated toggle
// route (POST /admin/tasks/:id/active) — the same #701 recompute parity the
// issue's "Carry the recompute" amendment requires of every route that
// replaces the old ones.
// ---------------------------------------------------------------------------
describe('#682 edit-route recompute parity: POST /admin/tasks/:id/edit', () => {
  it('un-hiding via special_mode=none strips a now-stale Completionist', async () => {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const taskA = makeTask('Edit AC2 Task A', 1);
    const hiddenTask = makeTask('Edit AC2 Hidden Task', 0);
    const guest = makeGuest('Edit AC2 Guest');
    submit(guest, taskA);
    grantCompletionistDirect(guest);
    expect(heldCodes(guest)).toContain('COMPLETIONIST');

    await adminAgent
      .post(`/admin/tasks/${hiddenTask}/edit`)
      .type('form')
      .send({ title: 'Edit AC2 Hidden Task', special_mode: 'none' });

    expect(
      db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(hiddenTask).special_mode
    ).toBe('none');
    expect(heldCodes(guest)).not.toContain('COMPLETIONIST');
  });

  it('hiding via special_mode=hidden awards a newly-earned Completionist', async () => {
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const taskA = makeTask('Edit AC3 Task A', 1);
    const uncoveredTask = makeTask('Edit AC3 Uncovered Task', 1);
    const guest = makeGuest('Edit AC3 Guest');
    submit(guest, taskA);
    expect(heldCodes(guest)).not.toContain('COMPLETIONIST');

    await adminAgent
      .post(`/admin/tasks/${uncoveredTask}/edit`)
      .type('form')
      .send({ title: 'Edit AC3 Uncovered Task', special_mode: 'hidden' });

    expect(
      db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(uncoveredTask).special_mode
    ).toBe('hidden');
    expect(heldCodes(guest)).toContain('COMPLETIONIST');
  });

  it('a worth-only or badge-only edit (no special_mode change) does NOT call recomputeAfterTaskChange at all', async () => {
    // Discriminating (review fix): a guest who already qualifies for
    // COMPLETIONIST still qualifies after a spurious recompute too, so
    // asserting only the held-badge OUTCOME (as this test did before) never
    // proves the conditional actually skipped the call — it would pass
    // identically whether or not the route wrongly recomputed on every save.
    // Spy on the real scoring.recomputeAfterTaskChange (the exact function
    // src/routes/admin.js's edit handler calls) and assert it is NOT invoked
    // for a worth-only change.
    db.prepare("UPDATE tasks SET special_mode = 'hidden'").run();
    const taskA = makeTask('Edit Worth-Only Task', 1);
    const guest = makeGuest('Edit Worth-Only Guest');
    submit(guest, taskA);
    grantCompletionistDirect(guest);
    expect(heldCodes(guest)).toContain('COMPLETIONIST');

    const recomputeSpy = vi.spyOn(scoring, 'recomputeAfterTaskChange');
    try {
      await adminAgent
        .post(`/admin/tasks/${taskA}/edit`)
        .type('form')
        .send({ title: 'Edit Worth-Only Task', worth: 3, special_mode: 'none' });

      expect(db.prepare('SELECT worth FROM tasks WHERE id = ?').get(taskA).worth).toBe(3);
      expect(recomputeSpy).not.toHaveBeenCalled();
      // The (unrecomputed) badge state is naturally still correct — nothing
      // moved the active-task set, so there was nothing to recompute away.
      expect(heldCodes(guest)).toContain('COMPLETIONIST');
    } finally {
      recomputeSpy.mockRestore();
    }
  });
});

describe('AC5 (edge case): recomputeAfterTaskChange is a safe no-op with zero guests', () => {
  // MUST run last in this file: within one test file `require('../../src/app')`
  // is cached after its first call, so this suite shares ONE db with every
  // describe above (see tests/rate-limit.test.js's "ONE loadApp() for the
  // whole file" note) — a second loadApp() would silently return the SAME
  // app/db, not an isolated fresh one. Wiping every guest row here is the
  // only way to exercise the true zero-guest case, and ON DELETE CASCADE
  // (guests -> submissions/guest_badges) means it also clears both tables.
  it('POST /admin/tasks succeeds and writes no guest_badges row when no guest exists', async () => {
    db.prepare('DELETE FROM guests').run();
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(0);

    const res = await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'No Guests Yet Task', badge_icon: 'favorite' });

    expect(res.status).toBe(303);
    expect(db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n).toBe(0);
  });
});
