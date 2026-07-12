// tests/per-photo-points.test.js
// Covers issue #89 acceptance criteria:
//   AC2 — a visible submission's feed points = 1 + photo_bonus
//   AC3 — admin POST bonus=4 sets submissions.photo_bonus absolutely, and the
//         feed then shows 1 + 4 = 5
//   AC4 — per-photo bonus counts toward the leaderboard total, and changes
//         guest ordering
//   AC5 — the public profile total reflects per-photo bonus
//   AC6 — a taken-down photo's bonus (and its base point) are excluded
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let dbModule;
let scoring;
let adminAgent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so config/db bind to the temp DATA_DIR/DB_PATH
  // (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS"). The db module is
  // captured too so the AC1 idempotency test can call the REAL guard
  // (ensurePhotoBonusColumn) rather than an inline copy of it.
  dbModule = require('../src/db');
  scoring = require('../src/services/scoring');

  adminAgent = await makeAdminAgent(app);
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
    .run(opts.taskTitle || 'Points Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, photo_bonus)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'points-test.jpg',
      opts.thumbPath || 'points-test-thumb.jpg',
      opts.takenDown ? 1 : 0,
      opts.photoBonus || 0
    ).lastInsertRowid;
  return submissionId;
}

function pointsInFeedBody(body, submissionId) {
  // Extract the single feed-item article for this submission id, then read
  // its points element — scoped so counts for other photos in the same
  // response can never bleed into this assertion (same pattern as
  // tests/photo-likes.test.js likeCountInFeedBody).
  const marker = 'id="photo-' + submissionId + '"';
  const start = body.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = body.indexOf('<article', start + marker.length);
  const chunk = body.slice(start, nextArticle === -1 ? body.length : nextArticle);
  const match = chunk.match(/<span class="points-count">(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// AC1: guarded migration — booting the app twice against the same DB file
// does not throw "duplicate column", and the column exists with the right shape.
// ---------------------------------------------------------------------------
it('AC1: submissions.photo_bonus exists as INTEGER NOT NULL DEFAULT 0, migration is idempotent', () => {
  const columns = db.prepare('PRAGMA table_info(submissions)').all();
  const photoBonusCol = columns.find((c) => c.name === 'photo_bonus');
  expect(photoBonusCol).toBeTruthy();
  expect(photoBonusCol.notnull).toBe(1);
  expect(photoBonusCol.dflt_value).toBe('0');

  // The guard is load-bearing: a NAKED add against the already-migrated DB
  // throws duplicate-column. This is what db.js would hit on a second boot if
  // it did not check PRAGMA table_info first — proving the guard is necessary,
  // not decorative.
  expect(() =>
    db.exec('ALTER TABLE submissions ADD COLUMN photo_bonus INTEGER NOT NULL DEFAULT 0')
  ).toThrow(/duplicate column/i);

  // Call db.js's REAL guard a second time against the live DB. This binds
  // directly to the shipped migration (not an inline copy): because the column
  // is already present, ensurePhotoBonusColumn's PRAGMA check skips the ADD
  // COLUMN, so it is a safe no-op. If db.js's guard were removed (an
  // unconditional ALTER), this second call would run a duplicate ALTER and
  // throw, failing the test (AC1).
  expect(() => dbModule.ensurePhotoBonusColumn()).not.toThrow();

  // And no duplicate was added: the column is present exactly once.
  const cols = db.prepare('PRAGMA table_info(submissions)').all();
  expect(cols.filter((c) => c.name === 'photo_bonus').length).toBe(1);
});

// ---------------------------------------------------------------------------
// AC2: feed shows a photo's points = 1 + its bonus.
// ---------------------------------------------------------------------------
it('AC2: a visible submission with photo_bonus=2 shows feed points 3', async () => {
  const author = await signedInGuest('ac2pts-author', 'AC2 Points Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac2pts.jpg',
    thumbPath: 'ac2ptst.jpg',
    photoBonus: 2,
  });

  const feedRes = await author.agent.get('/feed');
  expect(feedRes.status).toBe(200);
  expect(pointsInFeedBody(feedRes.text, submissionId)).toBe(3);
});

// ---------------------------------------------------------------------------
// AC3: admin awards per-photo points — absolute set, not additive.
// ---------------------------------------------------------------------------
it('AC3: admin POST bonus=4 sets DB photo_bonus to 4 and feed shows 5', async () => {
  const author = await signedInGuest('ac3pts-author', 'AC3 Points Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac3pts.jpg',
    thumbPath: 'ac3ptst.jpg',
    photoBonus: 0,
  });

  const postRes = await adminAgent
    .post('/admin/photos/' + submissionId + '/points')
    .type('form')
    .send({ bonus: 4 });
  expect(postRes.status).toBe(303);

  const row = db.prepare('SELECT photo_bonus FROM submissions WHERE id = ?').get(submissionId);
  expect(row.photo_bonus).toBe(4);

  const feedRes = await author.agent.get('/feed');
  expect(pointsInFeedBody(feedRes.text, submissionId)).toBe(5);
});

it('AC3 edge: admin POST with a negative bonus is rejected and does not write', async () => {
  const author = await signedInGuest('ac3neg-author', 'AC3 Negative Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac3neg.jpg',
    thumbPath: 'ac3negt.jpg',
    photoBonus: 0,
  });

  const postRes = await adminAgent
    .post('/admin/photos/' + submissionId + '/points')
    .type('form')
    .send({ bonus: -1 });
  expect(postRes.status).toBe(303);

  const row = db.prepare('SELECT photo_bonus FROM submissions WHERE id = ?').get(submissionId);
  expect(row.photo_bonus).toBe(0);
});

it('AC3 edge: admin POST with a non-integer bonus is rejected and does not write', async () => {
  const author = await signedInGuest('ac3dec-author', 'AC3 Decimal Author');
  const submissionId = seedSubmission(author.guestId, {
    photoPath: 'ac3dec.jpg',
    thumbPath: 'ac3dect.jpg',
    photoBonus: 0,
  });

  const postRes = await adminAgent
    .post('/admin/photos/' + submissionId + '/points')
    .type('form')
    .send({ bonus: '4.5' });
  expect(postRes.status).toBe(303);

  const row = db.prepare('SELECT photo_bonus FROM submissions WHERE id = ?').get(submissionId);
  expect(row.photo_bonus).toBe(0);
});

// ---------------------------------------------------------------------------
// AC4: per-photo points count on the leaderboard, and affect ordering.
// ---------------------------------------------------------------------------
it('AC4: guest B (photo_bonus=5) totals 6 and outranks guest A (photo_bonus=0, total 1)', async () => {
  const guestA = await signedInGuest('ac4-guest-a', 'AC4 Guest A');
  const guestB = await signedInGuest('ac4-guest-b', 'AC4 Guest B');

  seedSubmission(guestA.guestId, { photoPath: 'ac4a.jpg', thumbPath: 'ac4at.jpg', photoBonus: 0 });
  seedSubmission(guestB.guestId, { photoPath: 'ac4b.jpg', thumbPath: 'ac4bt.jpg', photoBonus: 5 });

  const pointsA = scoring.getPoints(guestA.guestId);
  const pointsB = scoring.getPoints(guestB.guestId);
  expect(pointsA).toBe(1);
  expect(pointsB).toBe(6);

  const rows = scoring.leaderboard();
  const rowA = rows.find((r) => r.id === guestA.guestId);
  const rowB = rows.find((r) => r.id === guestB.guestId);
  expect(rowA.points).toBe(1);
  expect(rowB.points).toBe(6);

  const indexA = rows.findIndex((r) => r.id === guestA.guestId);
  const indexB = rows.findIndex((r) => r.id === guestB.guestId);
  expect(indexB).toBeLessThan(indexA);

  // Confirm the same totals render on the public leaderboard page. /leaderboard
  // sits behind guest.js's blanket requireGuest (mounted at '/' ahead of
  // community.js, also mounted at '/'), so — same convention as
  // tests/photo-likes.test.js — read it through a signed-in guest's agent
  // rather than a bare unauthenticated request(app).
  const res = await guestA.agent.get('/leaderboard');
  expect(res.status).toBe(200);
  const posA = res.text.indexOf('AC4 Guest A');
  const posB = res.text.indexOf('AC4 Guest B');
  expect(posA).toBeGreaterThan(-1);
  expect(posB).toBeGreaterThan(-1);
  expect(posB).toBeLessThan(posA);
});

// ---------------------------------------------------------------------------
// AC5: profile total reflects per-photo points.
// ---------------------------------------------------------------------------
it('AC5: profile /u/<B id> shows 6 for a guest with one visible photo_bonus=5 submission', async () => {
  const guestB = await signedInGuest('ac5-guest-b', 'AC5 Guest B');
  seedSubmission(guestB.guestId, { photoPath: 'ac5b.jpg', thumbPath: 'ac5bt.jpg', photoBonus: 5 });

  expect(scoring.getPoints(guestB.guestId)).toBe(6);

  // /u/:guestId also sits behind guest.js's blanket requireGuest — view it
  // through a signed-in agent, same convention as the AC4 leaderboard check.
  const res = await guestB.agent.get('/u/' + guestB.guestId);
  expect(res.status).toBe(200);
  // Bind the 6 to the profile points element itself (public-profile.ejs
  // renders score.points inside a <strong> in the .profile-points header),
  // not a stray 6 elsewhere on the page — so this assertion is inversion-
  // sensitive: a wrong total (e.g. 1) would fail it.
  expect(res.text).toMatch(/class="profile-points">[\s\S]*?<strong>6<\/strong>/);
});

// ---------------------------------------------------------------------------
// AC6: a taken-down photo's bonus (and base point) are excluded.
// ---------------------------------------------------------------------------
it('AC6: a taken-down submission with photo_bonus=9 contributes 0 to the leaderboard total', async () => {
  const guest = await signedInGuest('ac6pts-guest', 'AC6 Points Guest');
  seedSubmission(guest.guestId, {
    photoPath: 'ac6pts.jpg',
    thumbPath: 'ac6ptst.jpg',
    photoBonus: 9,
    takenDown: true,
  });

  expect(scoring.getPoints(guest.guestId)).toBe(0);

  const rows = scoring.leaderboard();
  const row = rows.find((r) => r.id === guest.guestId);
  expect(row.points).toBe(0);
});
