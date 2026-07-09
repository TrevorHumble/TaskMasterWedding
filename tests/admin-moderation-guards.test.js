// tests/admin-moderation-guards.test.js
// Issue #181: every moderation route's not-found guard is a stale-form-post
// guard — a second admin tab acting on an already-deleted/hidden row during
// live moderation must get a message, not a crash.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js).
'use strict';

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

describe('photo moderation guards on an unknown submission id', () => {
  it('takedown: "Submission not found."', async () => {
    const res = await adminAgent.post('/admin/photos/99999/takedown').type('form').send({});
    expect(res.headers.location).toContain(encodeURIComponent('Submission not found.'));
  });

  it('restore: "Submission not found."', async () => {
    const res = await adminAgent.post('/admin/photos/99999/restore').type('form').send({});
    expect(res.headers.location).toContain(encodeURIComponent('Submission not found.'));
  });

  it('points: "Submission not found."', async () => {
    const res = await adminAgent
      .post('/admin/photos/99999/points')
      .type('form')
      .send({ bonus: '4' });
    expect(res.headers.location).toContain(encodeURIComponent('Submission not found.'));
  });
});

describe('comment moderation guards on an unknown comment id', () => {
  it('hide: "Comment not found."', async () => {
    const res = await adminAgent.post('/admin/comments/99999/hide').type('form').send({});
    expect(res.headers.location).toContain(encodeURIComponent('Comment not found.'));
  });

  it('restore: "Comment not found."', async () => {
    const res = await adminAgent.post('/admin/comments/99999/restore').type('form').send({});
    expect(res.headers.location).toContain(encodeURIComponent('Comment not found.'));
  });
});

describe('GET /admin/comments — admin sees everything', () => {
  it('both a live and a hidden comment appear in the HTML', async () => {
    const taskId = db
      .prepare('INSERT INTO tasks (title) VALUES (?)')
      .run('Comment Task').lastInsertRowid;
    const guestId = db
      .prepare('INSERT INTO guests (token, name) VALUES (?, ?)')
      .run('commenttoken000000000000000000', 'Comment Guest').lastInsertRowid;
    const submissionId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(guestId, taskId, 'c.jpg', 'c.jpg.jpg').lastInsertRowid;

    db.prepare(
      'INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, 0)'
    ).run(submissionId, guestId, 'A live comment, visible to all.');
    db.prepare(
      'INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, 1)'
    ).run(submissionId, guestId, 'A hidden comment, admin-only view.');

    const res = await adminAgent.get('/admin/comments');
    expect(res.status).toBe(200);
    expect(res.text).toContain('A live comment, visible to all.');
    expect(res.text).toContain('A hidden comment, admin-only view.');
  });
});
