// tests/self-like-block.test.js
// Covers issue #712 acceptance criteria:
//   AC1 — POST /p/:id/like on a guest's OWN submission is refused (JSON 403
//         with { error }, form redirect with no state change), no likes row,
//         no recompute.
//   AC2 — the exported db.cleanupSelfLikes() one-time cleanup removes exactly
//         the self-like rows, leaves cross-guest likes intact, returns the
//         removed count, and the transferable-badge recompute seam
//         (scoring.recomputeTransferableBadges()) still runs cleanly after it
//         (the MOSTLIKED badge it used to feed was retired by #711).
//   AC3 — a non-owner's like is unaffected (regression guard): the owner-block
//         never fires for someone who isn't the photo's author.
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call, per
// tests/photo-likes.test.js's convention.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;
let cleanupSelfLikes;

beforeAll(async () => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  // scoring and cleanupSelfLikes are safe to require only after loadApp()
  // has already required app.js (and therefore db.js) with the temp
  // DATA_DIR in place. result.db (from src/db.js's `db` export) is the raw
  // better-sqlite3 connection, not the db.js module object, so
  // cleanupSelfLikes is pulled from a fresh require of the module itself.
  scoring = require('../src/services/scoring');
  ({ cleanupSelfLikes } = require('../src/db'));
});

/**
 * Insert a guest row with the given token and return { guestId, agent } where
 * agent is a supertest agent already signed in as that guest — same pattern
 * as tests/photo-likes.test.js's signedInGuest.
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
    .run(opts.taskTitle || 'Self-Like Test Task').lastInsertRowid;
  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      authorGuestId,
      taskId,
      opts.photoPath || 'self-like-test.jpg',
      opts.thumbPath || 'self-like-test-thumb.jpg',
      opts.takenDown ? 1 : 0
    ).lastInsertRowid;
  return submissionId;
}

function likeCount(submissionId) {
  return db.prepare(`SELECT COUNT(*) AS n FROM likes WHERE submission_id = ?`).get(submissionId).n;
}

// ---------------------------------------------------------------------------
// AC1a: owner POST with Accept: application/json is refused with 403 + JSON
// body, no likes row, count unchanged.
// ---------------------------------------------------------------------------
it('AC1: owner POSTing the like toggle with Accept: json gets 403 and no row is created', async () => {
  const owner = await signedInGuest('sl-json-owner', 'JSON Owner');
  const submissionId = seedSubmission(owner.guestId, {
    photoPath: 'sl-json.jpg',
    thumbPath: 'sl-jsont.jpg',
  });

  const res = await owner.agent
    .post('/p/' + submissionId + '/like')
    .set('Accept', 'application/json');

  expect(res.status).toBe(403);
  expect(res.body).toEqual({ error: expect.any(String) });
  expect(typeof res.body.error).toBe('string');
  expect(res.body.error.length).toBeGreaterThan(0);

  const row = db
    .prepare(`SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, owner.guestId);
  expect(row).toBeUndefined();
  expect(likeCount(submissionId)).toBe(0);
});

// ---------------------------------------------------------------------------
// AC1b: owner POST as a plain form is refused with a redirect back to the
// bounded feed page, same shape the toggle route already uses, no state
// change.
// ---------------------------------------------------------------------------
it('AC1: owner POSTing the like toggle as a form redirects to the feed anchor with no row created', async () => {
  const owner = await signedInGuest('sl-form-owner', 'Form Owner');
  const submissionId = seedSubmission(owner.guestId, {
    photoPath: 'sl-form.jpg',
    thumbPath: 'sl-formt.jpg',
  });

  const res = await owner.agent.post('/p/' + submissionId + '/like');

  expect(res.status).toBe(302);
  expect(res.headers.location).toBe('/feed?from=' + submissionId + '#photo-' + submissionId);

  const row = db
    .prepare(`SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, owner.guestId);
  expect(row).toBeUndefined();
  expect(likeCount(submissionId)).toBe(0);
});

// ---------------------------------------------------------------------------
// AC3 (regression guard): a non-owner's like still works exactly as before —
// the new owner-block never fires for someone who isn't the photo's author.
// ---------------------------------------------------------------------------
it('AC3: a non-owner liking the photo still creates the row and returns { liked, likeCount }', async () => {
  const owner = await signedInGuest('sl-nonowner-author', 'Non-owner Author');
  const stranger = await signedInGuest('sl-nonowner-liker', 'Non-owner Liker');
  const submissionId = seedSubmission(owner.guestId, {
    photoPath: 'sl-nonowner.jpg',
    thumbPath: 'sl-nonownert.jpg',
  });

  const res = await stranger.agent
    .post('/p/' + submissionId + '/like')
    .set('Accept', 'application/json');

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ liked: true, likeCount: 1 });

  const row = db
    .prepare(`SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(submissionId, stranger.guestId);
  expect(row).toBeTruthy();
});

// ---------------------------------------------------------------------------
// AC2: db.cleanupSelfLikes() removes exactly the self-like rows, leaves
// cross-guest likes intact, and returns the removed count; the transferable
// recompute seam still runs cleanly once it follows the cleanup.
//
// This test seeds rows DIRECTLY via db (bypassing the now-guarded route) to
// simulate data that predates issue #712's route fix — loadApp() already ran
// the boot-time cleanup once against an empty DB before this test's rows
// exist, so calling the exported guard directly is the only way to exercise
// it against pre-existing self-like data, per the repo's "tests bind to the
// real guard" migration idiom.
// ---------------------------------------------------------------------------
it('AC2: cleanupSelfLikes deletes only self-likes, returns the count, and the recompute seam runs cleanly after', async () => {
  const inflater = await signedInGuest('sl-cleanup-inflater', 'Inflater');
  const genuine = await signedInGuest('sl-cleanup-genuine', 'Genuine Favorite');
  const admirer = await signedInGuest('sl-cleanup-admirer', 'Admirer');

  const inflaterSubmission = seedSubmission(inflater.guestId, {
    photoPath: 'sl-cleanup-inflater.jpg',
    thumbPath: 'sl-cleanup-inflatert.jpg',
  });
  const genuineSubmission = seedSubmission(genuine.guestId, {
    photoPath: 'sl-cleanup-genuine.jpg',
    thumbPath: 'sl-cleanup-genuinet.jpg',
  });

  // Pre-existing self-like data (as if seeded before #712's route fix
  // existed): the inflater liked their own photo THREE times over — not
  // reachable through the route anymore, so inserted directly — while the
  // genuine favorite has two real likes from other guests. Before cleanup,
  // the inflater's self-likes give them the higher (bogus) total.
  const insertLike = db.prepare(`INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)`);
  insertLike.run(inflaterSubmission, inflater.guestId); // self-like #1
  const inflaterSubmission2 = seedSubmission(inflater.guestId, {
    photoPath: 'sl-cleanup-inflater2.jpg',
    thumbPath: 'sl-cleanup-inflater2t.jpg',
  });
  insertLike.run(inflaterSubmission2, inflater.guestId); // self-like #2
  const inflaterSubmission3 = seedSubmission(inflater.guestId, {
    photoPath: 'sl-cleanup-inflater3.jpg',
    thumbPath: 'sl-cleanup-inflater3t.jpg',
  });
  insertLike.run(inflaterSubmission3, inflater.guestId); // self-like #3

  insertLike.run(genuineSubmission, admirer.guestId); // real, cross-guest like #1
  const secondAdmirer = await signedInGuest('sl-cleanup-admirer2', 'Second Admirer');
  insertLike.run(genuineSubmission, secondAdmirer.guestId); // real, cross-guest like #2

  // Before cleanup: inflater (3 self-likes) outranks genuine (2 real likes).
  expect(
    likeCount(inflaterSubmission) + likeCount(inflaterSubmission2) + likeCount(inflaterSubmission3)
  ).toBe(3);
  expect(likeCount(genuineSubmission)).toBe(2);

  const removed = cleanupSelfLikes();

  // Exactly the three self-like rows are gone; the two cross-guest likes on
  // genuine's photo survive untouched.
  expect(removed).toBe(3);
  expect(likeCount(inflaterSubmission)).toBe(0);
  expect(likeCount(inflaterSubmission2)).toBe(0);
  expect(likeCount(inflaterSubmission3)).toBe(0);
  expect(likeCount(genuineSubmission)).toBe(2);
  const survivingRow = db
    .prepare(`SELECT * FROM likes WHERE submission_id = ? AND guest_id = ?`)
    .get(genuineSubmission, admirer.guestId);
  expect(survivingRow).toBeTruthy();

  // The transferable-badge recompute this cleanup used to feed (the retired
  // MOSTLIKED badge, #711) is gone, but the seam it ran through must still
  // execute cleanly against the corrected like totals — proving cleanup and
  // recompute compose without error is still worth asserting even with an
  // empty transferable registry.
  expect(() => scoring.recomputeTransferableBadges()).not.toThrow();
});
