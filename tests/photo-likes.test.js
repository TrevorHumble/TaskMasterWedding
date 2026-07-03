// tests/photo-likes.test.js
// Covers issue #86 acceptance criteria:
//   AC2 — liking a photo records one like (DB row + feed count 1)
//   AC3 — a second like from the same guest toggles the row away (count 0)
//   AC4 — an anonymous request creates no likes row
//   AC5 — two distinct signed-in guests liking the same photo → feed count 2
//   AC6 — a taken-down submission's like row never surfaces (no form/count)
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest (via GET /j/<token>,
 * the same pattern tests/photo-feed.test.js uses).
 */
async function signedInGuest(token, name) {
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  const agent = request.agent(app);
  await agent.get('/j/' + token);
  return { guestId, agent };
}

/**
 * Insert a task + submission and return the submission id.
 */
function seedSubmission(authorGuestId, opts = {}) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run(opts.taskTitle || 'Likes Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'like-test.jpg',
      opts.thumbPath || 'like-test-thumb.jpg',
      opts.takenDown ? 1 : 0
    ).lastInsertRowid;
  return submissionId;
}

function likeCountInFeedBody(body, submissionId) {
  // Extract the single feed-item article for this submission id, then read
  // its like-count element — scoped so counts for other photos in the same
  // response can never bleed into this assertion.
  const marker = 'id="photo-' + submissionId + '"';
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = body.indexOf('<article', start + marker.length);
  const chunk = body.slice(start, nextArticle === -1 ? body.length : nextArticle);
  const match = chunk.match(/<span class="like-count">(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// AC2: liking a photo records one like + feed shows count 1.
// ---------------------------------------------------------------------------
it('AC2: POST /p/:id/like as a signed-in guest creates a row and feed count is 1', async () => {
  const author = await signedInGuest('ac2-author', 'AC2 Author');
  const liker = await signedInGuest('ac2-liker', 'AC2 Liker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac2.jpg',
    thumbPath: 'ac2t.jpg',
  });

  const res = await liker.agent.post('/p/' + submissionId + '/like');
  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/feed#photo-' + submissionId);

  const row = db
    .prepare(`SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, liker.guestId);
  expect(row).toBeTruthy();

  const feedRes = await liker.agent.get('/feed');
  expect(likeCountInFeedBody(feedRes.text, submissionId)).toBe(1);
});

// ---------------------------------------------------------------------------
// AC3: second POST from the same guest toggles the like away.
// ---------------------------------------------------------------------------
it('AC3: a second POST from the same guest removes the like and count returns to 0', async () => {
  const author = await signedInGuest('ac3-author', 'AC3 Author');
  const liker = await signedInGuest('ac3-liker', 'AC3 Liker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac3.jpg',
    thumbPath: 'ac3t.jpg',
  });

  await liker.agent.post('/p/' + submissionId + '/like');
  const afterFirst = db
    .prepare(`SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, liker.guestId);
  expect(afterFirst).toBeTruthy();

  await liker.agent.post('/p/' + submissionId + '/like');
  const afterSecond = db
    .prepare(`SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, liker.guestId);
  expect(afterSecond).toBeUndefined();

  const feedRes = await liker.agent.get('/feed');
  expect(likeCountInFeedBody(feedRes.text, submissionId)).toBe(0);
});

// ---------------------------------------------------------------------------
// AC4: anonymous request creates no likes row.
// ---------------------------------------------------------------------------
it('AC4: POST /p/:id/like with no guest cookie creates no likes row', async () => {
  const author = await signedInGuest('ac4-author', 'AC4 Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac4.jpg',
    thumbPath: 'ac4t.jpg',
  });

  const res = await request(app).post('/p/' + submissionId + '/like');
  expect(res.status).toBe(403);

  const row = db.prepare(`SELECT * FROM likes WHERE submission_id = ?`).get(submissionId);
  expect(row).toBeUndefined();
});

// ---------------------------------------------------------------------------
// AC5: two distinct signed-in guests liking the same photo -> feed count 2.
// ---------------------------------------------------------------------------
it('AC5: two distinct guests liking the same photo makes the feed count 2', async () => {
  const author = await signedInGuest('ac5-author', 'AC5 Author');
  const likerOne = await signedInGuest('ac5-liker-one', 'AC5 Liker One');
  const likerTwo = await signedInGuest('ac5-liker-two', 'AC5 Liker Two');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac5.jpg',
    thumbPath: 'ac5t.jpg',
  });

  await likerOne.agent.post('/p/' + submissionId + '/like');
  await likerTwo.agent.post('/p/' + submissionId + '/like');

  const count = db
    .prepare(`SELECT COUNT(*) AS n FROM likes WHERE submission_id = ?`)
    .get(submissionId).n;
  expect(count).toBe(2);

  const feedRes = await likerOne.agent.get('/feed');
  expect(likeCountInFeedBody(feedRes.text, submissionId)).toBe(2);
});

// ---------------------------------------------------------------------------
// AC6: likes on a taken-down submission never surface in the feed.
// ---------------------------------------------------------------------------
it('AC6: a taken-down submission with a like row renders no like form/count', async () => {
  const author = await signedInGuest('ac6-author', 'AC6 Author');
  const liker = await signedInGuest('ac6-liker', 'AC6 Liker');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac6.jpg',
    thumbPath: 'ac6t.jpg',
    takenDown: true,
  });

  // The like was placed while the photo was still visible, then the photo was
  // taken down. The like row persists, but the feed never renders that photo —
  // feed.allVisible() excludes it — so the like never surfaces.
  db.prepare(`INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(
    submissionId,
    liker.guestId
  );

  const feedRes = await liker.agent.get('/feed');
  expect(feedRes.status).toBe(200);
  expect(feedRes.text).not.toContain('id="photo-' + submissionId + '"');
  expect(feedRes.text).not.toContain('/p/' + submissionId + '/like');
});
