// tests/admin-tasks-crud.test.js
// Issue #181: task-admin CRUD/reorder routes need tests asserting the
// resulting DB state, extending (not duplicating) tests/admin-tasks-ui.test.js
// and tests/task-deletion.test.js.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;
let taskBadges;
let scoring;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
  taskBadges = require('../src/services/task-badges');
  scoring = require('../src/services/scoring');
});

describe('POST /admin/tasks — add to top', () => {
  it('with two existing tasks, add_to_top puts the new task before both', async () => {
    const a = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)')
      .run('Task A').lastInsertRowid;
    const b = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 1)')
      .run('Task B').lastInsertRowid;

    // Issue #682: badge is now required server-side, so every POST /admin/tasks
    // in this file carries a valid catalog badge_icon — see the "badge
    // required" describe block below for the create-refusal behavior itself.
    await adminAgent.post('/admin/tasks').type('form').send({
      title: 'Flash task',
      add_to_top: 'on',
      badge_icon: 'favorite',
      badge_name: 'Heart Badge',
    });

    const flash = db.prepare('SELECT sort_order FROM tasks WHERE title = ?').get('Flash task');
    const aOrder = db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(a).sort_order;
    const bOrder = db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(b).sort_order;

    expect(flash.sort_order).toBeLessThan(aOrder);
    expect(flash.sort_order).toBeLessThan(bOrder);
  });
});

describe('POST /admin/tasks/:id/edit', () => {
  it('updates title and description together', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title, description) VALUES (?, ?)')
      .run('Old Title', 'Old description').lastInsertRowid;

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: 'New Title', description: 'New description' });

    const row = db.prepare('SELECT title, description FROM tasks WHERE id = ?').get(id);
    expect(row.title).toBe('New Title');
    expect(row.description).toBe('New description');
  });

  it('unknown id redirects with "Task not found."', async () => {
    const res = await adminAgent.post('/admin/tasks/999999/edit').type('form').send({ title: 'X' });
    expect(res.headers.location).toContain(encodeURIComponent('Task not found.'));
  });

  it('empty title is refused and the row is left unchanged', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title, description) VALUES (?, ?)')
      .run('Keep Me', 'Keep this too').lastInsertRowid;

    const res = await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: '  ', description: 'Attempted change' });

    expect(res.headers.location).toContain(encodeURIComponent('needs a title'));
    const row = db.prepare('SELECT title, description FROM tasks WHERE id = ?').get(id);
    expect(row.title).toBe('Keep Me');
    expect(row.description).toBe('Keep this too');
  });
});

describe('POST /admin/tasks/:id/active', () => {
  it('toggles special_mode none->hidden with "hidden from guests", then hidden->none with "now active"', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('Toggle Task').lastInsertRowid;

    let res = await adminAgent.post(`/admin/tasks/${id}/active`).type('form').send({});
    expect(db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(id).special_mode).toBe(
      'hidden'
    );
    expect(res.headers.location).toContain(encodeURIComponent('hidden from guests'));

    res = await adminAgent.post(`/admin/tasks/${id}/active`).type('form').send({});
    expect(db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(id).special_mode).toBe(
      'none'
    );
    expect(res.headers.location).toContain(encodeURIComponent('now active'));
  });
});

// POST /admin/tasks/reorder (the old neighbor-swap up/down/top route) was
// REMOVED — issue #682's redesign deleted its UI, and its sort_order swap
// semantics diverged from the new drag handle's POST /admin/tasks/reorder-all
// contiguous 0..n-1 renumbering (see the "AC-C" describe block further down
// this file for that route's coverage). This describe block's three tests
// (down-swap, move-to-top, and the up/bad-direction/unknown-id edge cases)
// tested the removed route directly and have no equivalent left to assert —
// deleted rather than repointed.

describe('POST /admin/tasks/:id/delete — survives a missing file', () => {
  it('deletes the task and submission row even though the file is already gone', async () => {
    const taskId = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('Task With Missing File').lastInsertRowid;
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('taskdeltoken00000000000000000a', 'Task Del Guest').lastInsertRowid;
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(guestId, taskId, 'gone-forever.jpg', 'gone-forever.jpg.jpg').lastInsertRowid;

    // Confirm neither file exists on disk before the delete (this is the point).
    const config = require('../config');
    expect(fs.existsSync(path.join(config.UPLOADS_DIR, 'gone-forever.jpg'))).toBe(false);

    const res = await adminAgent.post(`/admin/tasks/${taskId}/delete`).type('form').send({});

    expect(res.status).toBe(303);
    expect(db.prepare('SELECT id FROM tasks WHERE id = ?').get(taskId)).toBeUndefined();
    expect(db.prepare('SELECT id FROM submissions WHERE id = ?').get(submissionId)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Issue #682 — the phase-2 wiring of the redesigned Tasks admin page: the
// 3-step create wizard (badge required), the single edit-popup save (worth/
// badge/special_mode together), and the drag-reorder persist endpoint.
// ---------------------------------------------------------------------------

describe('AC-A: POST /admin/tasks — badge required, persists worth/special_mode/badge', () => {
  it('a submit with no valid badge_icon creates NO task row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

    const res = await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'No Badge Task', worth: 2 });

    expect(res.headers.location).toContain(encodeURIComponent('Choose a badge'));
    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(before);
    expect(db.prepare('SELECT id FROM tasks WHERE title = ?').get('No Badge Task')).toBeUndefined();
  });

  it('an unrecognized badge_icon also creates no row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'Bad Icon Task', worth: 1, badge_icon: 'not-a-real-icon' });

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(before);
  });

  it('title + worth 2 + Special None + badge "Golden Moment" yields exactly that task', async () => {
    await adminAgent.post('/admin/tasks').type('form').send({
      title: 'Photo with the couple',
      worth: 2,
      special_mode: 'none',
      badge_icon: 'diamond',
      badge_name: 'Golden Moment',
    });

    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('Photo with the couple');
    expect(task).toBeDefined();
    expect(task.worth).toBe(2);
    expect(task.special_mode).toBe('none');

    const badge = db.prepare('SELECT * FROM badges WHERE task_id = ?').get(task.id);
    expect(badge.name).toBe('Golden Moment');
    expect(badge.art_path).toBe('/badges/icons/diamond.svg');
  });

  it('Special Hidden yields a task hidden from its very first render (never briefly guest-visible)', async () => {
    await adminAgent.post('/admin/tasks').type('form').send({
      title: 'Surprise Hidden Task',
      worth: 1,
      special_mode: 'hidden',
      badge_icon: 'star',
      badge_name: 'Star',
    });

    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('Surprise Hidden Task');
    expect(task.special_mode).toBe('hidden');

    db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
      'ac-a-hidden-guest',
      'AC-A Hidden Guest'
    );
    const guestAgent = signInGuest(app, 'ac-a-hidden-guest');
    const listRes = await guestAgent.get('/tasks');
    expect(listRes.text).not.toContain('Surprise Hidden Task');
    const detailRes = await guestAgent.get(`/tasks/${task.id}`);
    expect(detailRes.status).toBe(404);
  });

  it('creating a task as Hidden does NOT call scoring.recomputeAfterTaskChange (review fix: pins the gating condition)', async () => {
    // Discriminating, same shape as the worth-only-edit recompute test
    // (tests/task-badge-recompute.test.js): a Hidden task never joins the
    // active set, so nothing currently fails if the `tasks.isTaskLive(...)`
    // gate on this call were deleted entirely — this spy is what actually
    // pins the condition rather than just its (unaffected) outcome.
    const recomputeSpy = vi.spyOn(scoring, 'recomputeAfterTaskChange');
    try {
      const res = await adminAgent.post('/admin/tasks').type('form').send({
        title: 'Hidden Create No Recompute',
        worth: 1,
        special_mode: 'hidden',
        badge_icon: 'favorite',
      });

      expect(res.status).toBe(303);
      expect(
        db
          .prepare('SELECT special_mode FROM tasks WHERE title = ?')
          .get('Hidden Create No Recompute').special_mode
      ).toBe('hidden');
      expect(recomputeSpy).not.toHaveBeenCalled();
    } finally {
      recomputeSpy.mockRestore();
    }
  });

  it('creating a task as None (live) DOES call scoring.recomputeAfterTaskChange', async () => {
    // The other half of the same pin — confirms the gate is a real
    // condition (live -> called), not a spy that would pass either way if
    // the branch were accidentally inverted.
    const recomputeSpy = vi.spyOn(scoring, 'recomputeAfterTaskChange');
    try {
      const res = await adminAgent.post('/admin/tasks').type('form').send({
        title: 'Live Create Does Recompute',
        worth: 1,
        special_mode: 'none',
        badge_icon: 'favorite',
      });

      expect(res.status).toBe(303);
      expect(recomputeSpy).toHaveBeenCalledTimes(1);
    } finally {
      recomputeSpy.mockRestore();
    }
  });

  it('worth falls back to DEFAULT_WORTH and special_mode falls back to none for out-of-range/unknown values', async () => {
    await adminAgent.post('/admin/tasks').type('form').send({
      title: 'Fallback Worth Task',
      worth: 99,
      special_mode: 'not-a-real-mode',
      badge_icon: 'favorite',
    });

    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('Fallback Worth Task');
    expect(task.worth).toBe(1);
    expect(task.special_mode).toBe('none');
  });
});

describe('AC-B: POST /admin/tasks/:id/edit — single save persists worth/badge/special_mode', () => {
  it('saves title, description, worth, badge, and special_mode together in one submit', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)')
      .run('AC-B Original Title', 1).lastInsertRowid;

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC-B New Title',
      description: 'AC-B new description',
      worth: 3,
      special_mode: 'none',
      badge_icon: 'trophy',
      badge_name: 'Champion',
    });

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    expect(task.title).toBe('AC-B New Title');
    expect(task.description).toBe('AC-B new description');
    expect(task.worth).toBe(3);
    expect(task.special_mode).toBe('none');

    const badge = db.prepare('SELECT * FROM badges WHERE task_id = ?').get(id);
    expect(badge.name).toBe('Champion');
    expect(badge.art_path).toBe('/badges/icons/trophy.svg');
  });

  it('saving special_mode Hidden removes the task from guest surfaces; saving back to None restores it — exactly one mode value stored throughout', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('AC-B Visibility Task').lastInsertRowid;
    db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
      'ac-b-visibility-guest',
      'AC-B Guest'
    );
    const guestAgent = signInGuest(app, 'ac-b-visibility-guest');

    let listRes = await guestAgent.get('/tasks');
    expect(listRes.text).toContain('AC-B Visibility Task');

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: 'AC-B Visibility Task', special_mode: 'hidden' });

    let row = db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(id);
    expect(row.special_mode).toBe('hidden');
    listRes = await guestAgent.get('/tasks');
    expect(listRes.text).not.toContain('AC-B Visibility Task');

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: 'AC-B Visibility Task', special_mode: 'none' });

    row = db.prepare('SELECT special_mode FROM tasks WHERE id = ?').get(id);
    expect(row.special_mode).toBe('none');
    listRes = await guestAgent.get('/tasks');
    expect(listRes.text).toContain('AC-B Visibility Task');
  });

  it('a partial submit (title/description only, no worth/badge/mode) leaves worth, mode, and badge unchanged', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title, worth, special_mode) VALUES (?, ?, ?)')
      .run('AC-B Partial Before', 3, 'hidden').lastInsertRowid;
    // A task's badges row is created LAZILY (task-badges.js resolveTaskBadge,
    // issue #483) the first time it's asked for — a direct db insert above
    // never triggers that, so seed it the same way GET /admin/tasks would.
    require('../src/services/task-badges').resolveTaskBadge(id);
    const badgeBefore = db.prepare('SELECT * FROM badges WHERE task_id = ?').get(id);

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({ title: 'AC-B Partial After', description: 'still no worth/mode/badge fields' });

    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    expect(task.title).toBe('AC-B Partial After');
    expect(task.worth).toBe(3);
    expect(task.special_mode).toBe('hidden');
    const badgeAfter = db.prepare('SELECT * FROM badges WHERE task_id = ?').get(id);
    expect(badgeAfter.name).toBe(badgeBefore.name);
    expect(badgeAfter.art_path).toBe(badgeBefore.art_path);
  });

  it('an unrecognized badge_icon refuses the WHOLE edit — title/worth/mode are left unchanged too', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title, worth, special_mode) VALUES (?, ?, ?)')
      .run('AC-B Reject Before', 2, 'none').lastInsertRowid;

    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC-B Reject Attempted',
      worth: 3,
      special_mode: 'hidden',
      badge_icon: 'not-a-real-icon',
    });

    expect(res.headers.location).toContain(encodeURIComponent('not recognized'));
    const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    expect(task.title).toBe('AC-B Reject Before');
    expect(task.worth).toBe(2);
    expect(task.special_mode).toBe('none');
  });
});

describe('Atomic task+badge write (review fix, issue #682)', () => {
  it('create: if setTaskBadge throws mid-write, the task row is NOT left committed without its badge', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;
    const setBadgeSpy = vi.spyOn(taskBadges, 'setTaskBadge').mockImplementationOnce(() => {
      throw new Error('boom — simulated setTaskBadge failure');
    });

    try {
      const res = await adminAgent.post('/admin/tasks').type('form').send({
        title: 'Atomic Create Task',
        worth: 1,
        special_mode: 'none',
        badge_icon: 'favorite',
        badge_name: 'Atomic Badge',
      });

      // Express 4 catches a synchronous throw from a route handler and
      // routes it to the default error handler — a 500, not the route's own
      // 303 success redirect.
      expect(res.status).toBe(500);
      // The whole transaction (task INSERT + setTaskBadge) rolled back
      // together — no orphaned "task with no badge" row was left behind.
      expect(db.prepare('SELECT id FROM tasks WHERE title = ?').get('Atomic Create Task')).toBe(
        undefined
      );
      expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(before);
    } finally {
      setBadgeSpy.mockRestore();
    }
  });

  it('edit: if setTaskBadge throws mid-write, the title/worth/mode UPDATE is also rolled back', async () => {
    const id = db
      .prepare('INSERT INTO tasks (title, worth, special_mode) VALUES (?, ?, ?)')
      .run('Atomic Edit Before', 1, 'none').lastInsertRowid;
    const setBadgeSpy = vi.spyOn(taskBadges, 'setTaskBadge').mockImplementationOnce(() => {
      throw new Error('boom — simulated setTaskBadge failure');
    });

    try {
      const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
        title: 'Atomic Edit Attempted',
        worth: 3,
        special_mode: 'hidden',
        badge_icon: 'favorite',
        badge_name: 'Atomic Badge',
      });

      expect(res.status).toBe(500);
      // Neither half of the combined submit landed — title/worth/mode are
      // still exactly what they were before this POST.
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      expect(task.title).toBe('Atomic Edit Before');
      expect(task.worth).toBe(1);
      expect(task.special_mode).toBe('none');
    } finally {
      setBadgeSpy.mockRestore();
    }
  });
});

describe('AC-C: POST /admin/tasks/reorder-all — persists a full drag-reordered list', () => {
  // Every test in this describe block wipes the tasks table first (ON DELETE
  // CASCADE also clears their submissions/badges) — reorder-all's set-
  // integrity guard (review fix) requires the posted list to equal the
  // COMPLETE current task set, and this test FILE shares one DB across many
  // preceding describes that each leave their own tasks behind, so a bare
  // 3-task posted array would otherwise always mismatch the dozens of other
  // tasks earlier tests created.
  it('re-numbers sort_order to match the posted order, and the guest task list reflects it', async () => {
    db.prepare('DELETE FROM tasks').run();
    const t1 = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)')
      .run('AC-C Task One').lastInsertRowid;
    const t2 = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 1)')
      .run('AC-C Task Two').lastInsertRowid;
    const t3 = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 2)')
      .run('AC-C Task Three').lastInsertRowid;

    const res = await adminAgent.post('/admin/tasks/reorder-all').send({ order: [t3, t1, t2] });

    expect(res.status).toBe(200);
    expect(db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(t3).sort_order).toBe(0);
    expect(db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(t1).sort_order).toBe(1);
    expect(db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(t2).sort_order).toBe(2);

    db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(
      'ac-c-reorder-guest',
      'AC-C Guest'
    );
    const guestAgent = signInGuest(app, 'ac-c-reorder-guest');
    const listRes = await guestAgent.get('/tasks');
    const posThree = listRes.text.indexOf('AC-C Task Three');
    const posOne = listRes.text.indexOf('AC-C Task One');
    const posTwo = listRes.text.indexOf('AC-C Task Two');
    expect(posThree).toBeGreaterThan(-1);
    expect(posThree).toBeLessThan(posOne);
    expect(posOne).toBeLessThan(posTwo);
  });

  it('an empty/missing order list is refused with a 400 and touches no row', async () => {
    db.prepare('DELETE FROM tasks').run();
    db.prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)').run('AC-C Empty Guard Task');
    const before = db.prepare('SELECT id, sort_order FROM tasks ORDER BY id').all();

    const res = await adminAgent.post('/admin/tasks/reorder-all').send({});

    expect(res.status).toBe(400);
    expect(db.prepare('SELECT id, sort_order FROM tasks ORDER BY id').all()).toEqual(before);
  });

  it('a posted list that omits an existing task (a stale/partial post) is refused with a 400 and touches no row (review fix: set-integrity guard)', async () => {
    db.prepare('DELETE FROM tasks').run();
    const keep1 = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)')
      .run('AC-C Integrity Keep One').lastInsertRowid;
    const keep2 = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 1)')
      .run('AC-C Integrity Keep Two').lastInsertRowid;
    // A third task exists but is deliberately OMITTED from the posted order —
    // simulates a stale client post (e.g. a card that existed when the drag
    // started but was deleted, or a second concurrent drag) racing a delete.
    db.prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 2)').run(
      'AC-C Integrity Omitted Task'
    );
    const before = db.prepare('SELECT id, sort_order FROM tasks ORDER BY id').all();

    const res = await adminAgent.post('/admin/tasks/reorder-all').send({ order: [keep2, keep1] });

    expect(res.status).toBe(400);
    // No row's sort_order changed — NOT even a partial renumber of the two
    // posted ids.
    expect(db.prepare('SELECT id, sort_order FROM tasks ORDER BY id').all()).toEqual(before);
  });

  it('a posted list with a duplicate id (same length as the real set, but not a true match) is refused with a 400', async () => {
    db.prepare('DELETE FROM tasks').run();
    const only = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)')
      .run('AC-C Integrity Duplicate Task').lastInsertRowid;
    db.prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 1)').run(
      'AC-C Integrity Duplicate Other'
    );
    const before = db.prepare('SELECT id, sort_order FROM tasks ORDER BY id').all();

    // Same array LENGTH as the real 2-task set, but `only` posted twice and
    // the other task omitted entirely — a naive length-only check would
    // wrongly accept this.
    const res = await adminAgent.post('/admin/tasks/reorder-all').send({ order: [only, only] });

    expect(res.status).toBe(400);
    expect(db.prepare('SELECT id, sort_order FROM tasks ORDER BY id').all()).toEqual(before);
  });
});

describe("AC-D: GET /admin/tasks renders each card's REAL worth, not a faked value", () => {
  it('a worth-3 task renders "+3 pts" on the admin card', async () => {
    db.prepare('INSERT INTO tasks (title, worth) VALUES (?, ?)').run('AC-D Worth-3 Task', 3);

    const res = await adminAgent.get('/admin/tasks');
    const titleIdx = res.text.indexOf('AC-D Worth-3 Task');
    expect(titleIdx).toBeGreaterThan(-1);
    const pointsIdx = res.text.indexOf('task-points">', titleIdx);
    expect(pointsIdx).toBeGreaterThan(-1);
    expect(res.text.slice(pointsIdx, pointsIdx + 40)).toContain('+3 pt');
  });
});
