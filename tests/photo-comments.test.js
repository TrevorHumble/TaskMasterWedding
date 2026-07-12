// tests/photo-comments.test.js
// Covers issue #87 acceptance criteria:
//   AC2 — posting a comment inserts a row AND the feed renders its literal body
//   AC3 — comment text is escaped (XSS guard)
//   AC4 — a 301-character body is rejected server-side (no row created)
//   AC5 — admin hide removes the body from the feed; restore returns it
//   AC6 — an anonymous hide request leaves taken_down at 0 (admin-gated)
//   AC7 — a comment on a taken-down photo, and a hidden comment on a visible
//         photo, never surface in the feed
//   AC8 — an anonymous POST creates no comments row
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest (via signInGuest,
 * the same pattern tests/photo-likes.test.js uses).
 */
async function signedInGuest(token, name) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return { guestId, agent };
}

/**
 * Insert a task + submission and return the submission id.
 */
function seedSubmission(authorGuestId, opts = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || 'Comments Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'comment-test.jpg',
      opts.thumbPath || 'comment-test-thumb.jpg',
      opts.takenDown ? 1 : 0
    ).lastInsertRowid;
  return submissionId;
}

/**
 * Slice out just the feed-item article for one submission id, so assertions
 * about one photo's comments can never bleed into another photo's markup.
 */
function feedItemChunk(body, submissionId) {
  const marker = 'id="photo-' + submissionId + '"';
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = body.indexOf('<article', start + marker.length);
  return body.slice(start, nextArticle === -1 ? body.length : nextArticle);
}

// ---------------------------------------------------------------------------
// AC2: posting a comment inserts a row and the feed renders its literal body.
// ---------------------------------------------------------------------------
it('AC2: POST /p/:id/comments as a signed-in guest creates a row and the feed renders it', async () => {
  const author = await signedInGuest('ac2-author', 'AC2 Author');
  const commenter = await signedInGuest('ac2-commenter', 'AC2 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac2c.jpg',
    thumbPath: 'ac2ct.jpg',
  });

  const res = await commenter.agent
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body: 'Nice shot' });
  expect(res.status).toBe(302);
  // Redirect returns to the bounded feed page CONTAINING this photo (#194).
  expect(res.headers.location).toBe('/feed?from=' + submissionId + '#photo-' + submissionId);

  const row = db
    .prepare(`SELECT * FROM comments WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, commenter.guestId);
  expect(row).toBeTruthy();
  expect(row.body).toBe('Nice shot');

  const feedRes = await commenter.agent.get('/feed');
  const chunk = feedItemChunk(feedRes.text, submissionId);
  expect(chunk).toContain('Nice shot');
});

// ---------------------------------------------------------------------------
// AC3: comment text is escaped — the raw script tag never reaches the response.
// ---------------------------------------------------------------------------
it('AC3: a comment body of <script>alert(1)</script> renders escaped, not raw', async () => {
  const author = await signedInGuest('ac3-author', 'AC3 Author');
  const commenter = await signedInGuest('ac3-commenter', 'AC3 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac3c.jpg',
    thumbPath: 'ac3ct.jpg',
  });

  await commenter.agent
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body: '<script>alert(1)</script>' });

  const feedRes = await commenter.agent.get('/feed');
  const chunk = feedItemChunk(feedRes.text, submissionId);
  expect(chunk).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  expect(chunk).not.toContain('<script>alert(1)</script>');
});

// ---------------------------------------------------------------------------
// AC4: a 301-character body is rejected server-side — no row is created.
// ---------------------------------------------------------------------------
it('AC4: a 301-character comment body creates no row', async () => {
  const author = await signedInGuest('ac4-author', 'AC4 Author');
  const commenter = await signedInGuest('ac4-commenter', 'AC4 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac4c.jpg',
    thumbPath: 'ac4ct.jpg',
  });

  const longBody = 'x'.repeat(301);
  const res = await commenter.agent
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body: longBody });
  expect(res.status).toBe(302);

  const row = db.prepare(`SELECT * FROM comments WHERE body = ?`).get(longBody);
  expect(row).toBeUndefined();

  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM comments WHERE submission_id = ?`)
    .get(submissionId).n;
  expect(count).toBe(0);
});

// ---------------------------------------------------------------------------
// AC5: admin hide removes the body from the feed; restore returns it.
// ---------------------------------------------------------------------------
it('AC5: admin hide removes a comment from the feed and restore returns it', async () => {
  const author = await signedInGuest('ac5-author', 'AC5 Author');
  const commenter = await signedInGuest('ac5-commenter', 'AC5 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac5c.jpg',
    thumbPath: 'ac5ct.jpg',
  });

  await commenter.agent
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body: 'hide me' });
  const commentId = db
    .prepare(`SELECT id FROM comments WHERE submission_id = ? AND body = ?`)
    .get(submissionId, 'hide me').id;

  const adminAgent = await makeAdminAgent(app, 'ac5-admin-pw');

  const hideRes = await adminAgent.post('/admin/comments/' + commentId + '/hide');
  expect(hideRes.status).toBe(303);

  const afterHide = db.prepare(`SELECT taken_down FROM comments WHERE id = ?`).get(commentId);
  expect(afterHide.taken_down).toBe(1);

  const feedAfterHide = await commenter.agent.get('/feed');
  const chunkAfterHide = feedItemChunk(feedAfterHide.text, submissionId);
  expect(chunkAfterHide).not.toContain('hide me');

  const restoreRes = await adminAgent.post('/admin/comments/' + commentId + '/restore');
  expect(restoreRes.status).toBe(303);

  const afterRestore = db.prepare(`SELECT taken_down FROM comments WHERE id = ?`).get(commentId);
  expect(afterRestore.taken_down).toBe(0);

  const feedAfterRestore = await commenter.agent.get('/feed');
  const chunkAfterRestore = feedItemChunk(feedAfterRestore.text, submissionId);
  expect(chunkAfterRestore).toContain('hide me');
});

// ---------------------------------------------------------------------------
// AC6: only the host can moderate — an anonymous hide request is rejected and
// the comment's taken_down flag stays 0.
// ---------------------------------------------------------------------------
it('AC6: POST /admin/comments/:id/hide with no admin session leaves taken_down at 0', async () => {
  const author = await signedInGuest('ac6-author', 'AC6 Author');
  const commenter = await signedInGuest('ac6-commenter', 'AC6 Commenter');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac6c.jpg',
    thumbPath: 'ac6ct.jpg',
  });

  await commenter.agent
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body: 'still visible' });
  const commentId = db
    .prepare(`SELECT id FROM comments WHERE submission_id = ? AND body = ?`)
    .get(submissionId, 'still visible').id;

  const res = await request(app).post('/admin/comments/' + commentId + '/hide');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/admin/login');

  const row = db.prepare(`SELECT taken_down FROM comments WHERE id = ?`).get(commentId);
  expect(row.taken_down).toBe(0);
});

// ---------------------------------------------------------------------------
// AC7: hidden comments and comments on taken-down photos never surface.
// ---------------------------------------------------------------------------
it('AC7: a comment on a taken-down photo and a hidden comment on a visible photo both stay absent', async () => {
  const author = await signedInGuest('ac7-author', 'AC7 Author');
  const viewer = await signedInGuest('ac7-viewer', 'AC7 Viewer');

  // A taken-down photo carrying a comment.
  const hiddenPhotoId = seedSubmission(author.guestId, {
    photoPath: 'ac7-hidden-photo.jpg',
    thumbPath: 'ac7-hidden-photo-t.jpg',
    takenDown: true,
  });
  db.prepare(`INSERT INTO comments (submission_id, guest_id, body) VALUES (?, ?, ?)`).run(
    hiddenPhotoId,
    viewer.guestId,
    'on-hidden-photo'
  );

  // A visible photo carrying a comment whose own taken_down flag is 1.
  const visiblePhotoId = seedSubmission(author.guestId, {
    photoPath: 'ac7-visible-photo.jpg',
    thumbPath: 'ac7-visible-photo-t.jpg',
  });
  db.prepare(
    `INSERT INTO comments (submission_id, guest_id, body, taken_down) VALUES (?, ?, ?, 1)`
  ).run(visiblePhotoId, viewer.guestId, 'ghost');

  const feedRes = await viewer.agent.get('/feed');
  expect(feedRes.status).toBe(200);
  expect(feedRes.text).not.toContain('on-hidden-photo');
  expect(feedRes.text).not.toContain('ghost');
});

// ---------------------------------------------------------------------------
// AC8: anonymous cannot comment — no row is created.
// ---------------------------------------------------------------------------
it('AC8: POST /p/:id/comments with no guest cookie creates no comments row', async () => {
  const author = await signedInGuest('ac8-author', 'AC8 Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac8c.jpg',
    thumbPath: 'ac8ct.jpg',
  });

  const res = await request(app)
    .post('/p/' + submissionId + '/comments')
    .type('form')
    .send({ body: 'anonymous comment' });
  // requireGuest redirects an unauthenticated request to /join (issue #241)
  // rather than 403ing it; either way the route handler never runs.
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/join');

  const row = db.prepare(`SELECT * FROM comments WHERE submission_id = ?`).get(submissionId);
  expect(row).toBeUndefined();
});
