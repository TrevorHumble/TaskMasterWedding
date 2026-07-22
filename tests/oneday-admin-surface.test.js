// tests/oneday-admin-surface.test.js
// Issue #755 acceptance criteria — the one-day-only HOST surface: set a
// day/bonus and it sticks (AC1), nothing leaks between tasks (AC2), bad input
// is refused not absorbed (AC3), a stale-dated task stays fully editable
// (AC3b), a guest submission locks the pair (AC4), the board shows what is
// dated (AC5), and hiding never costs the host their day (AC6).
//
// Default event config (src/db.js's getEventConfig fallback) is
// startDate=2026-08-07, endDate=2026-08-09 — so 'Aug 7'/'Aug 8'/'Aug 9' are
// the three configured day chips for every test below unless a test
// deliberately narrows the range to create a stale date (AC3b).
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

const DAY1 = '2026-08-07';
const DAY2 = '2026-08-08';
const DAY3 = '2026-08-09';

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
});

// One badge_icon every create POST in this file carries — badge is required
// server-side (issue #682 AC-A), unrelated to what this file tests.
const BADGE = { badge_icon: 'favorite', badge_name: 'Test Badge' };

function insertTask(overrides) {
  const cols = Object.assign(
    {
      title: 'Oneday Test Task',
      worth: 1,
      special_mode: 'none',
      special_date: null,
      special_bonus: null,
    },
    overrides
  );
  return db
    .prepare(
      `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
       VALUES (@title, @worth, @special_mode, @special_date, @special_bonus)`
    )
    .run(cols).lastInsertRowid;
}

function insertSubmission(taskId, { takenDown = false } = {}) {
  const guestId = db
    .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
    .run(
      'oneday-admin-guest-' + Math.random().toString(36).slice(2),
      'Oneday Guest'
    ).lastInsertRowid;
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, 'p.jpg', 'p.jpg.jpg', takenDown ? 1 : 0).lastInsertRowid;
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
}

// ---------------------------------------------------------------------------
// AC1: set a day and bonus, and it sticks.
// ---------------------------------------------------------------------------
describe('AC1: create/edit round-trips special_date and special_bonus', () => {
  test('POST /admin/tasks with special_mode=oneday persists the posted day and bonus', async () => {
    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC1 Create Dated',
        worth: 1,
        special_mode: 'oneday',
        special_date: DAY3,
        special_bonus: 3,
        ...BADGE,
      });

    const task = db.prepare('SELECT * FROM tasks WHERE title = ?').get('AC1 Create Dated');
    expect(task.special_mode).toBe('oneday');
    expect(task.special_date).toBe(DAY3);
    expect(task.special_bonus).toBe(3);
  });

  test('editing to Aug 9 / +3 and re-reading the task shows Aug 9 / +3, not the first chip', async () => {
    const id = insertTask({ title: 'AC1 Edit Round Trip' });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC1 Edit Round Trip',
      special_mode: 'oneday',
      special_date: DAY3,
      special_bonus: 3,
    });

    const task = getTask(id);
    expect(task.special_date).toBe(DAY3);
    expect(task.special_bonus).toBe(3);
  });

  test('choosing None on a task with no submissions clears special_date/special_bonus', async () => {
    const id = insertTask({
      title: 'AC1 Clear',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC1 Clear',
      special_mode: 'none',
    });

    const task = getTask(id);
    expect(task.special_mode).toBe('none');
    expect(task.special_date).toBeNull();
    expect(task.special_bonus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2: nothing leaks between tasks.
// ---------------------------------------------------------------------------
describe('AC2: a save on an ordinary task opened straight after a dated one stores no date/bonus', () => {
  test('editing an ordinary task without special_mode=oneday never picks up a previous dated value', async () => {
    // Simulate the "opened a dated task, then an ordinary one" sequence at
    // the route level: two independent edits, neither referencing the other.
    const datedId = insertTask({
      title: 'AC2 Dated',
      special_mode: 'oneday',
      special_date: DAY3,
      special_bonus: 3,
    });
    await adminAgent.post(`/admin/tasks/${datedId}/edit`).type('form').send({
      title: 'AC2 Dated',
      special_mode: 'oneday',
      special_date: DAY3,
      special_bonus: 3,
    });

    const ordinaryId = insertTask({ title: 'AC2 Ordinary' });
    await adminAgent.post(`/admin/tasks/${ordinaryId}/edit`).type('form').send({
      title: 'AC2 Ordinary',
      special_mode: 'none',
    });

    const ordinary = getTask(ordinaryId);
    expect(ordinary.special_date).toBeNull();
    expect(ordinary.special_bonus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC3: bad input is refused, not absorbed.
// ---------------------------------------------------------------------------
describe('AC3: an invalid pair is refused and stored values are left unchanged', () => {
  test('CREATE: special_mode=oneday with a missing date writes NO task row at all', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

    const res = await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC3 Create Missing Date',
        special_mode: 'oneday',
        special_bonus: 1,
        ...BADGE,
      });

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(before);
    expect(
      db.prepare('SELECT id FROM tasks WHERE title = ?').get('AC3 Create Missing Date')
    ).toBeUndefined();
    expect(res.status).toBe(303);
  });

  test('CREATE: special_mode=oneday with BOTH date and bonus absent writes NO task row (pins the undefined-vs-null CREATE sentinel)', async () => {
    // Regression pin: resolveSpecialPairWrite must treat CREATE's "no stored
    // task" as `undefined`, not `null` — an ordinary task's stored pair really
    // is `(null, null)`, so if CREATE used that same `null` sentinel, an empty
    // posted 'oneday' pair `(null, null)` would compare EQUAL to it, pairChanged
    // would read false, and validation would never run — silently inserting a
    // 'oneday' task with no date at all.
    const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC3 Create Both Absent',
        special_mode: 'oneday',
        ...BADGE,
      });

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(before);
    expect(
      db.prepare('SELECT id FROM tasks WHERE title = ?').get('AC3 Create Both Absent')
    ).toBeUndefined();
  });

  test('CREATE: special_mode=oneday with a date outside the configured range writes NO task row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC3 Create Out Of Range',
        special_mode: 'oneday',
        special_date: '2026-08-01',
        special_bonus: 1,
        ...BADGE,
      });

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(before);
  });

  test('CREATE: special_mode=oneday with a bonus outside 1-3 writes NO task row', async () => {
    const before = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({
        title: 'AC3 Create Bad Bonus',
        special_mode: 'oneday',
        special_date: DAY1,
        special_bonus: 9,
        ...BADGE,
      });

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n).toBe(before);
  });

  test('EDIT: changing to a missing date is refused, stored pair unchanged', async () => {
    const id = insertTask({
      title: 'AC3 Edit Missing',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 Edit Missing',
      special_mode: 'oneday',
      special_bonus: 2,
    });

    const task = getTask(id);
    expect(task.special_date).toBe(DAY1);
    expect(task.special_bonus).toBe(1);
    expect(res.status).toBe(303);
  });

  test('EDIT: changing to an out-of-range date is refused, stored pair unchanged', async () => {
    const id = insertTask({
      title: 'AC3 Edit Range',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 Edit Range',
      special_mode: 'oneday',
      special_date: '2026-12-25',
      special_bonus: 1,
    });

    const task = getTask(id);
    expect(task.special_date).toBe(DAY1);
  });

  test('EDIT: changing to a bonus outside 1-3 is refused, stored pair unchanged', async () => {
    const id = insertTask({
      title: 'AC3 Edit Bonus',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 Edit Bonus',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 0,
    });

    const task = getTask(id);
    expect(task.special_bonus).toBe(1);
  });

  test('EDIT: re-posting the EXACT stored pair (a no-op) succeeds — not refused as unchanged-invalid', async () => {
    const id = insertTask({
      title: 'AC3 No-op Repost',
      special_mode: 'oneday',
      special_date: DAY2,
      special_bonus: 2,
    });

    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 No-op Repost Renamed',
      special_mode: 'oneday',
      special_date: DAY2,
      special_bonus: 2,
    });

    expect(res.headers.location).toContain(encodeURIComponent('Task updated.'));
    const task = getTask(id);
    expect(task.title).toBe('AC3 No-op Repost Renamed');
    expect(task.special_date).toBe(DAY2);
    expect(task.special_bonus).toBe(2);
  });

  test('a partial POST (title/description only, special_mode absent) leaves a dated task exactly as stored', async () => {
    const id = insertTask({
      title: 'AC3 Partial POST',
      special_mode: 'oneday',
      special_date: DAY2,
      special_bonus: 2,
    });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3 Partial POST After',
      description: 'still no special_mode field',
    });

    const task = getTask(id);
    expect(task.special_mode).toBe('oneday');
    expect(task.special_date).toBe(DAY2);
    expect(task.special_bonus).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC3b: a stale-dated task stays fully editable.
// ---------------------------------------------------------------------------
describe('AC3b: a stale-dated task (date outside the CURRENT configured range) stays editable', () => {
  test('a title-only edit succeeds and leaves the stale date/bonus unchanged, with or without a submission', async () => {
    const staleId = insertTask({
      title: 'AC3b Stale No Sub',
      special_mode: 'oneday',
      special_date: '2099-01-01',
      special_bonus: 2,
    });

    await adminAgent.post(`/admin/tasks/${staleId}/edit`).type('form').send({
      title: 'AC3b Stale No Sub Renamed',
      special_mode: 'oneday',
      special_date: '2099-01-01',
      special_bonus: 2,
    });

    const task = getTask(staleId);
    expect(task.title).toBe('AC3b Stale No Sub Renamed');
    expect(task.special_date).toBe('2099-01-01');
    expect(task.special_bonus).toBe(2);

    const staleWithSubId = insertTask({
      title: 'AC3b Stale With Sub',
      special_mode: 'oneday',
      special_date: '2099-01-01',
      special_bonus: 2,
    });
    insertSubmission(staleWithSubId);

    await adminAgent.post(`/admin/tasks/${staleWithSubId}/edit`).type('form').send({
      title: 'AC3b Stale With Sub Renamed',
      special_mode: 'oneday',
      special_date: '2099-01-01',
      special_bonus: 2,
    });

    const task2 = getTask(staleWithSubId);
    expect(task2.title).toBe('AC3b Stale With Sub Renamed');
    expect(task2.special_date).toBe('2099-01-01');
    expect(task2.special_bonus).toBe(2);
  });

  test('picking a valid day chip on a stale task with no submissions repairs it', async () => {
    const id = insertTask({
      title: 'AC3b Repair No Sub',
      special_mode: 'oneday',
      special_date: '2099-01-01',
      special_bonus: 2,
    });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3b Repair No Sub',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    const task = getTask(id);
    expect(task.special_date).toBe(DAY1);
    expect(task.special_bonus).toBe(1);
  });

  test('picking a valid day chip on a stale task WITH a submission is refused by criterion 4', async () => {
    const id = insertTask({
      title: 'AC3b Repair With Sub',
      special_mode: 'oneday',
      special_date: '2099-01-01',
      special_bonus: 2,
    });
    insertSubmission(id);

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC3b Repair With Sub',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    const task = getTask(id);
    expect(task.special_date).toBe('2099-01-01');
    expect(task.special_bonus).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// AC4: once a guest has posted a photo, the day and bonus are locked. Every
// refusal tested with BOTH a visible and a taken-down submission (the taken-
// down half is the PRIMARY guard guest.js's own comments cite), and every
// "succeeds" case tested to catch a guard written one conjunct too wide.
// ---------------------------------------------------------------------------
describe.each([
  ['a VISIBLE submission', false],
  ['a TAKEN-DOWN submission', true],
])('AC4: the lock, with %s', (_label, takenDown) => {
  test('switching an ORDINARY task with a submission to One day only is refused', async () => {
    const id = insertTask({ title: 'AC4 Ordinary To Dated ' + takenDown });
    insertSubmission(id, { takenDown });

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({
        title: 'AC4 Ordinary To Dated ' + takenDown,
        special_mode: 'oneday',
        special_date: DAY1,
        special_bonus: 1,
      });

    const task = getTask(id);
    expect(task.special_mode).toBe('none');
    expect(task.special_date).toBeNull();
    expect(task.special_bonus).toBeNull();
  });

  test("moving a DATED task's day is refused", async () => {
    const id = insertTask({
      title: 'AC4 Move Day ' + takenDown,
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    insertSubmission(id, { takenDown });

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({
        title: 'AC4 Move Day ' + takenDown,
        special_mode: 'oneday',
        special_date: DAY2,
        special_bonus: 1,
      });

    const task = getTask(id);
    expect(task.special_date).toBe(DAY1);
  });

  test("changing a DATED task's bonus is refused", async () => {
    const id = insertTask({
      title: 'AC4 Change Bonus ' + takenDown,
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    insertSubmission(id, { takenDown });

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({
        title: 'AC4 Change Bonus ' + takenDown,
        special_mode: 'oneday',
        special_date: DAY1,
        special_bonus: 3,
      });

    const task = getTask(id);
    expect(task.special_bonus).toBe(1);
  });

  test('switching a DATED task to None is refused', async () => {
    const id = insertTask({
      title: 'AC4 To None ' + takenDown,
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    insertSubmission(id, { takenDown });

    await adminAgent
      .post(`/admin/tasks/${id}/edit`)
      .type('form')
      .send({
        title: 'AC4 To None ' + takenDown,
        special_mode: 'none',
      });

    const task = getTask(id);
    expect(task.special_mode).toBe('oneday');
    expect(task.special_date).toBe(DAY1);
    expect(task.special_bonus).toBe(1);
  });
});

describe('AC4: everything that leaves the pair alone still succeeds on a dated task with a submission', () => {
  test('a title-only edit succeeds', async () => {
    const id = insertTask({
      title: 'AC4 Succeed Title',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    insertSubmission(id);

    const res = await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Succeed Title Renamed',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    expect(res.headers.location).toContain(encodeURIComponent('Task updated.'));
    const task = getTask(id);
    expect(task.title).toBe('AC4 Succeed Title Renamed');
    expect(task.special_date).toBe(DAY1);
    expect(task.special_bonus).toBe(1);
  });

  test('a badge change succeeds', async () => {
    const id = insertTask({
      title: 'AC4 Succeed Badge',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    insertSubmission(id);

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Succeed Badge',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
      badge_icon: 'star',
      badge_name: 'Star Badge',
    });

    const badge = db.prepare('SELECT * FROM badges WHERE task_id = ?').get(id);
    expect(badge.name).toBe('Star Badge');
    const task = getTask(id);
    expect(task.special_date).toBe(DAY1);
  });

  test('a worth change succeeds', async () => {
    const id = insertTask({
      title: 'AC4 Succeed Worth',
      worth: 1,
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });
    insertSubmission(id);

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC4 Succeed Worth',
      worth: 3,
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    const task = getTask(id);
    expect(task.worth).toBe(3);
    expect(task.special_date).toBe(DAY1);
    expect(task.special_bonus).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC5: the board shows what is dated.
// ---------------------------------------------------------------------------
describe('AC5: GET /admin/tasks renders each dated task its day chip', () => {
  test('a saved one-day-only task carries an admin-chip-oneday chip with its label', async () => {
    insertTask({
      title: 'AC5 Dated Board',
      special_mode: 'oneday',
      special_date: DAY3,
      special_bonus: 2,
    });

    const res = await adminAgent.get('/admin/tasks');
    const idx = res.text.indexOf('AC5 Dated Board');
    expect(idx).toBeGreaterThan(-1);
    const cardStart = res.text.lastIndexOf('<li class="admin-task-card', idx);
    const cardEnd = res.text.indexOf('</li>', idx);
    const card = res.text.slice(cardStart, cardEnd);
    expect(card).toContain('admin-chip-oneday');
    expect(card).toContain('Aug 9 only');
  });

  test('a task whose stored date falls outside the configured range still shows that date, never blank/undefined', async () => {
    insertTask({
      title: 'AC5 Stale Board',
      special_mode: 'oneday',
      special_date: '2026-12-25',
      special_bonus: 1,
    });

    const res = await adminAgent.get('/admin/tasks');
    const idx = res.text.indexOf('AC5 Stale Board');
    expect(idx).toBeGreaterThan(-1);
    const cardStart = res.text.lastIndexOf('<li class="admin-task-card', idx);
    const cardEnd = res.text.indexOf('</li>', idx);
    const card = res.text.slice(cardStart, cardEnd);
    expect(card).toContain('admin-chip-oneday');
    expect(card).not.toContain('undefined');
    expect(card).toContain('Dec 25 only');
  });

  test('a value GET /admin/tasks would 500 on (an impossible-but-shaped date) renders no chip and does not crash the page', async () => {
    insertTask({
      title: 'AC5 Malformed Board',
      special_mode: 'oneday',
      special_date: '2026-13-45',
      special_bonus: 1,
    });

    const res = await adminAgent.get('/admin/tasks');
    expect(res.status).toBe(200);
    const idx = res.text.indexOf('AC5 Malformed Board');
    expect(idx).toBeGreaterThan(-1);
    const cardStart = res.text.lastIndexOf('<li class="admin-task-card', idx);
    const cardEnd = res.text.indexOf('</li>', idx);
    const card = res.text.slice(cardStart, cardEnd);
    expect(card).not.toContain('admin-chip-oneday');
  });

  test('an ORDINARY task renders no admin-chip-oneday chip and no populated data-special-date attribute', async () => {
    insertTask({ title: 'AC5 Ordinary Board' });

    const res = await adminAgent.get('/admin/tasks');
    const idx = res.text.indexOf('AC5 Ordinary Board');
    expect(idx).toBeGreaterThan(-1);
    const cardStart = res.text.lastIndexOf('<li class="admin-task-card', idx);
    const cardEnd = res.text.indexOf('</li>', idx);
    const card = res.text.slice(cardStart, cardEnd);
    expect(card).not.toContain('admin-chip-oneday');
    expect(card).toContain('data-special-date=""');
  });

  test('a dated task carries its raw data-special-date/data-special-bonus attributes', async () => {
    insertTask({
      title: 'AC5 Data Attrs',
      special_mode: 'oneday',
      special_date: DAY2,
      special_bonus: 3,
    });

    const res = await adminAgent.get('/admin/tasks');
    const idx = res.text.indexOf('AC5 Data Attrs');
    expect(idx).toBeGreaterThan(-1);
    const cardStart = res.text.lastIndexOf('<li class="admin-task-card', idx);
    const cardEnd = res.text.indexOf('</li>', idx);
    const card = res.text.slice(cardStart, cardEnd);
    expect(card).toContain(`data-special-date="${DAY2}"`);
    expect(card).toContain('data-special-bonus="3"');
  });
});

// ---------------------------------------------------------------------------
// AC6: hiding never costs the host their day, and no route strands a date
// behind `none`.
// ---------------------------------------------------------------------------
describe('AC6: POST /admin/tasks/:id/active is a special_date-aware writer', () => {
  test('hide then un-hide on a dated task with a submission: still the same day/bonus throughout', async () => {
    const id = insertTask({
      title: 'AC6 Hide Unhide',
      special_mode: 'oneday',
      special_date: DAY3,
      special_bonus: 3,
    });
    insertSubmission(id);

    await adminAgent.post(`/admin/tasks/${id}/active`).type('form').send({});
    let task = getTask(id);
    expect(task.special_mode).toBe('hidden');
    expect(task.special_date).toBe(DAY3);
    expect(task.special_bonus).toBe(3);

    await adminAgent.post(`/admin/tasks/${id}/active`).type('form').send({});
    task = getTask(id);
    expect(task.special_mode).toBe('oneday');
    expect(task.special_date).toBe(DAY3);
    expect(task.special_bonus).toBe(3);
  });

  test('un-hiding a task with no valid special_date falls back to none, not oneday', async () => {
    const id = insertTask({ title: 'AC6 Unhide No Date', special_mode: 'hidden' });

    await adminAgent.post(`/admin/tasks/${id}/active`).type('form').send({});

    const task = getTask(id);
    expect(task.special_mode).toBe('none');
  });

  test('the edit route writing hidden on a dated task leaves special_date/special_bonus intact', async () => {
    const id = insertTask({
      title: 'AC6 Edit To Hidden',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC6 Edit To Hidden',
      special_mode: 'hidden',
    });

    const task = getTask(id);
    expect(task.special_mode).toBe('hidden');
    expect(task.special_date).toBe(DAY1);
    expect(task.special_bonus).toBe(1);
  });

  test('the edit route writing none on a dated task with NO submissions clears both', async () => {
    const id = insertTask({
      title: 'AC6 Edit To None',
      special_mode: 'oneday',
      special_date: DAY1,
      special_bonus: 1,
    });

    await adminAgent.post(`/admin/tasks/${id}/edit`).type('form').send({
      title: 'AC6 Edit To None',
      special_mode: 'none',
    });

    const task = getTask(id);
    expect(task.special_mode).toBe('none');
    expect(task.special_date).toBeNull();
    expect(task.special_bonus).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Markup/script-level: the edit dialog's hidden stale-date input (issue #755
// criterion 3b) — a route-level test alone would pass green while the host
// UI stayed locked, since the hidden input is what lets the popup re-post a
// stale date at all.
// ---------------------------------------------------------------------------
describe('AC3b markup: the edit dialog hidden special_date input', () => {
  test('the edit dialog renders a disabled hidden special_date input, and the day chips come from the configured range', async () => {
    const res = await adminAgent.get('/admin/tasks');
    expect(res.text).toContain('id="task-edit-special-date-stale"');
    expect(res.text).toMatch(/<input type="hidden" name="special_date"[^>]*disabled/);
    expect(res.text).toContain('value="' + DAY1 + '"');
    expect(res.text).toContain('value="' + DAY2 + '"');
    expect(res.text).toContain('value="' + DAY3 + '"');
  });

  test('the accordion renders no chip pre-checked (all selection is script-driven, not baked into the markup)', async () => {
    const res = await adminAgent.get('/admin/tasks');
    // Isolate the special-oneday-option block within the edit dialog and
    // confirm no day/bonus radio in it carries `checked` in the raw HTML.
    const editDialogStart = res.text.indexOf('id="task-edit-dialog"');
    const editDialogEnd = res.text.indexOf('</dialog>', editDialogStart);
    const editDialogHtml = res.text.slice(editDialogStart, editDialogEnd);
    const dayBonusInputs = editDialogHtml.match(
      /<input type="radio" name="special_(date|bonus)"[^>]*>/g
    );
    expect(dayBonusInputs).not.toBeNull();
    dayBonusInputs.forEach((tag) => {
      expect(tag).not.toContain('checked');
    });
  });
});
