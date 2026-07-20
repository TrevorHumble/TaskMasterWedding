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
let adminAgent;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
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

  // POST /admin/photos/:id/points was retired (issue #684, owner: a freeform
  // points override "feels unfair") — every id, known or not, gets a real
  // 404 now (renderNotFound), not a "not found" redirect. See
  // tests/admin-moderation-684.test.js AC7 for the retirement coverage.
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

// GET /admin/comments was retired (issue #684): comment moderation now
// happens in context, under each photo in GET /admin/photos. "Admin sees
// everything, including hidden comments" is covered there now — see
// tests/admin-moderation-684.test.js AC4/AC6.
