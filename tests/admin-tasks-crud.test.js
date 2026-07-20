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
const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  adminAgent = await makeAdminAgent(app);
});

describe('POST /admin/tasks — add to top', () => {
  it('with two existing tasks, add_to_top puts the new task before both', async () => {
    const a = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 0)')
      .run('Task A').lastInsertRowid;
    const b = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 1)')
      .run('Task B').lastInsertRowid;

    await adminAgent
      .post('/admin/tasks')
      .type('form')
      .send({ title: 'Flash task', add_to_top: 'on' });

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

describe('POST /admin/tasks/reorder', () => {
  it("direction=down swaps the two neighbors' sort_order exactly", async () => {
    const a = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 100)')
      .run('Reorder A').lastInsertRowid;
    const b = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 101)')
      .run('Reorder B').lastInsertRowid;

    await adminAgent.post('/admin/tasks/reorder').type('form').send({ id: a, direction: 'down' });

    const aRow = db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(a);
    const bRow = db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(b);
    expect(aRow.sort_order).toBe(101);
    expect(bRow.sort_order).toBe(100);
  });

  it('direction=top puts the bottom task at the strict minimum sort_order', async () => {
    const bottom = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, 200)')
      .run('Bottom Task').lastInsertRowid;

    await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: bottom, direction: 'top' });

    const minOrder = db.prepare('SELECT MIN(sort_order) AS m FROM tasks').get().m;
    const row = db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(bottom);
    expect(row.sort_order).toBe(minOrder);
  });

  it('edge cases: up at the top edge, a bad direction, and an unknown id', async () => {
    // Make a task the strict minimum so "up" has no neighbor above it.
    const topId = db
      .prepare('INSERT INTO tasks (title, sort_order) VALUES (?, -1000)')
      .run('Edge Top').lastInsertRowid;
    const before = db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(topId).sort_order;

    let res = await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: topId, direction: 'up' });
    expect(res.headers.location).toContain(encodeURIComponent('already at the edge'));
    expect(db.prepare('SELECT sort_order FROM tasks WHERE id = ?').get(topId).sort_order).toBe(
      before
    );

    res = await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: topId, direction: 'sideways' });
    expect(res.headers.location).toContain(encodeURIComponent('Bad reorder direction.'));

    res = await adminAgent
      .post('/admin/tasks/reorder')
      .type('form')
      .send({ id: 999999, direction: 'down' });
    expect(res.headers.location).toContain(encodeURIComponent('Task not found.'));
  });
});

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
