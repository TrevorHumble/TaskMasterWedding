// tests/memories.test.js
// Issue #247 — "Share a memory": a guest can upload a batch of photos straight
// to the shared gallery, not tied to any task (submissions.task_id IS NULL).
// Covers AC1-AC12 from the issue, including the abuse guardrails (rate limit +
// disk-space guard).
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH env vars, matching tests/submission-intake.test.js and
// tests/per-photo-points.test.js.
//
// RATE-LIMIT ENV: MEMORY_RATE_MAX is pinned to a small value at module scope
// (below), before loadApp() requires config — so the AC11 test can exhaust the
// per-guest window in a few fast requests. The window is left at its generous
// default so it never expires mid-test. Every test uses a fresh guest, and the
// limiter is keyed per guest, so this small global cap never bleeds across
// tests (no single guest submits more than TEST_MEMORY_RATE_MAX legit batches).
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');
const sharp = require('sharp');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

// Set BEFORE loadApp() (which requires config) so config.MEMORY_RATE_MAX picks
// this up. Module-level, so it runs before the beforeAll that calls loadApp().
const TEST_MEMORY_RATE_MAX = 3;
process.env.MEMORY_RATE_MAX = String(TEST_MEMORY_RATE_MAX);

let app;
let db;
let config;
let photos;
let scoring;
let badges;
let rateLimit;
let validJpeg;

beforeAll(async () => {
  validJpeg = await sharp({
    create: { width: 6, height: 6, channels: 3, background: { r: 40, g: 90, b: 60 } },
  })
    .jpeg()
    .toBuffer();

  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  config = require('../config');
  photos = require('../src/services/photos');
  scoring = require('../src/services/scoring');
  badges = require('../src/services/badges');
  rateLimit = require('../src/services/rate-limit');
});

function insertGuest(name) {
  const token = `memories-${crypto.randomUUID()}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(token, name).lastInsertRowid;
  return { guestId, token };
}

function insertTask(title, isActive = 1) {
  return db.prepare(`INSERT INTO tasks (title, is_active) VALUES (?, ?)`).run(title, isActive)
    .lastInsertRowid;
}

async function agentFor(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

/** Insert a submission row directly (bypassing the upload route/pipeline),
 * for tests focused on downstream consumers (scoring/badges/gallery/feed)
 * rather than the intake pipeline itself. taskId=null makes it a memory. */
let seqCounter = 0;
function insertSubmission({ guestId, taskId = null, caption = '', takenDown = 0, photoBonus = 0 }) {
  seqCounter += 1;
  const photoPath = `mem-${seqCounter}.jpg`;
  const thumbPath = `mem-${seqCounter}-t.jpg`;
  const info = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down, photo_bonus)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, photoPath, thumbPath, caption, takenDown, photoBonus);
  return { submissionId: info.lastInsertRowid, photoPath, thumbPath };
}

/** Slice out one feed <article> by its submission id, so assertions never
 * bleed into a sibling card's markup (same pattern as
 * tests/per-photo-points.test.js pointsInFeedBody). */
function feedArticleChunk(html, submissionId) {
  const marker = 'id="photo-' + submissionId + '"';
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const nextArticle = html.indexOf('<article', start + marker.length);
  return html.slice(start, nextArticle === -1 ? html.length : nextArticle);
}

/** Read the numeric feed-card point count for one submission — scoped to that
 * card's <article> so a sibling card's count can't bleed in (feed.ejs renders
 * it inside <span class="points-count">). */
function feedPointsFor(html, submissionId) {
  const chunk = feedArticleChunk(html, submissionId);
  const match = chunk.match(/<span class="points-count">(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------------------
// Guarded migration — submissions.task_id is nullable, and re-running the
// guard against an already-migrated DB is a safe no-op (same idempotency
// contract as db.js's other guarded migrations, e.g.
// tests/per-photo-points.test.js AC1 for ensurePhotoBonusColumn).
// ---------------------------------------------------------------------------
it('submissions.task_id is nullable, and ensureTaskIdNullable() is a no-op the second time', () => {
  const dbModule = require('../src/db');

  const cols = db.prepare('PRAGMA table_info(submissions)').all();
  const taskCol = cols.find((c) => c.name === 'task_id');
  expect(taskCol).toBeTruthy();
  expect(taskCol.notnull).toBe(0);

  // Calling the real guard again against the live (already-migrated) DB must
  // not throw and must not duplicate/alter the table.
  expect(() => dbModule.ensureTaskIdNullable()).not.toThrow();
  const colsAfter = db.prepare('PRAGMA table_info(submissions)').all();
  expect(colsAfter.filter((c) => c.name === 'task_id')).toHaveLength(1);
  expect(colsAfter.find((c) => c.name === 'task_id').notnull).toBe(0);

  // UNIQUE(guest_id, task_id) still holds for real task rows: a second
  // (guest, task) submission must still collide (this constraint is not
  // "fixed" by the migration, per the issue's plan step 1 note).
  const guestId = insertGuest('Migration Guest').guestId;
  const taskId = insertTask('Migration Task');
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path) VALUES (?, ?, 'm.jpg', 'mt.jpg')`
  ).run(guestId, taskId);
  expect(() =>
    db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path) VALUES (?, ?, 'm2.jpg', 'mt2.jpg')`
      )
      .run(guestId, taskId)
  ).toThrow(/UNIQUE constraint failed/i);
  // (Multiple task_id=NULL memory rows for the same guest NOT colliding is
  // exercised by AC1 below, which inserts 3 memory rows for one guest.)
});

// ---------------------------------------------------------------------------
// AC3 (zero-memory case) — run FIRST, before any test below creates a memory,
// so the DB genuinely has none yet.
// ---------------------------------------------------------------------------
describe('AC3 (zero memories): no Memories heading renders', () => {
  it('/gallery?view=task has no "Memories" heading when zero memories exist', async () => {
    const { token } = insertGuest('Zero Memories Guest');
    const agent = await agentFor(token);

    const res = await agent.get('/gallery?view=task');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<h2 class="gallery-group-heading">Memories</h2>');
  });
});

// ---------------------------------------------------------------------------
// AC1 — a batch of 3 valid JPEGs with a caption creates 3 memory rows, 3
// thumbnails, and leaves the guest's points unchanged.
// ---------------------------------------------------------------------------
describe('AC1: batch of 3 valid JPEGs with a caption', () => {
  it('creates 3 task_id=NULL rows with the caption, 3 thumbnails, points unchanged', async () => {
    const { guestId, token } = insertGuest('AC1 Guest');
    const agent = await agentFor(token);

    const pointsBefore = scoring.getPoints(guestId);

    const res = await agent
      .post('/memories')
      .field('caption', 'late night')
      .attach('photos', validJpeg, { filename: 'm1.jpg', contentType: 'image/jpeg' })
      .attach('photos', validJpeg, { filename: 'm2.jpg', contentType: 'image/jpeg' })
      .attach('photos', validJpeg, { filename: 'm3.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/gallery');

    const rows = db
      .prepare(`SELECT * FROM submissions WHERE guest_id = ? AND task_id IS NULL ORDER BY id ASC`)
      .all(guestId);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.task_id).toBeNull();
      expect(row.caption).toBe('late night');
      expect(fs.existsSync(photos.absThumbPath(row.thumb_path))).toBe(true);
      expect(fs.existsSync(photos.absOriginalPath(row.photo_path))).toBe(true);
    }

    // Behavioral: points before == points after (memories earn no base point).
    const pointsAfter = scoring.getPoints(guestId);
    expect(pointsAfter).toBe(pointsBefore);

    // The success flash renders on the redirect target. EJS's <%= %> escapes
    // the apostrophe to &#39; (header.ejs renders _flash.msg escaped), so this
    // matches the escaped form rather than a literal apostrophe.
    const page = await agent.get('/gallery');
    expect(page.text).toContain('Shared! They&#39;re in the gallery.');
  });
});

// ---------------------------------------------------------------------------
// AC2 — an 11-file batch is rejected: no rows inserted, and the re-rendered
// form contains the literal cap message.
// ---------------------------------------------------------------------------
describe('AC2: an 11-file batch is rejected', () => {
  it('inserts no rows and re-renders the form with "Ten photos at a time"', async () => {
    const { guestId, token } = insertGuest('AC2 Guest');
    const agent = await agentFor(token);

    const countBefore = db
      .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ?`)
      .get(guestId).n;
    expect(countBefore).toBe(0);

    let req = agent.post('/memories').field('caption', 'too many');
    for (let i = 0; i < 11; i++) {
      req = req.attach('photos', validJpeg, {
        filename: `over-${i}.jpg`,
        contentType: 'image/jpeg',
      });
    }
    const res = await req;

    expect(res.status).toBe(200); // re-rendered directly, not a redirect
    expect(res.text).toContain('Ten photos at a time');

    const countAfter = db
      .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ?`)
      .get(guestId).n;
    expect(countAfter).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC3 (non-zero case) — a Memories section renders in /gallery?view=task.
// ---------------------------------------------------------------------------
describe('AC3: Memories section renders with at least one memory', () => {
  it('a "Memories" heading exists and contains the memory\'s tile', async () => {
    const { guestId, token } = insertGuest('AC3 Guest');
    const { thumbPath } = insertSubmission({ guestId, caption: 'ac3 memory' });
    const agent = await agentFor(token);

    const res = await agent.get('/gallery?view=task');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h2 class="gallery-group-heading">Memories</h2>');
    expect(res.text).toContain('/thumbs/' + thumbPath);
  });
});

// ---------------------------------------------------------------------------
// AC4 — a memory's feed card reads "a shared memory" and has no
// /gallery?task= anchor; a task submission's card, by contrast, DOES.
// ---------------------------------------------------------------------------
describe('AC4: feed card distinguishes a memory from a task submission', () => {
  it('memory card: "a shared memory", no /gallery?task= anchor', async () => {
    const { guestId, token } = insertGuest('AC4 Memory Guest');
    const { submissionId } = insertSubmission({ guestId, caption: 'ac4 memory' });
    const agent = await agentFor(token);

    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    const chunk = feedArticleChunk(res.text, submissionId);
    expect(chunk).toContain('a shared memory');
    expect(chunk).not.toContain('/gallery?task=');
  });

  it('task-submission card: DOES contain a /gallery?task= anchor', async () => {
    const { guestId, token } = insertGuest('AC4 Task Guest');
    const taskId = insertTask('AC4 Task');
    const { submissionId } = insertSubmission({ guestId, taskId, caption: 'ac4 task photo' });
    const agent = await agentFor(token);

    const res = await agent.get('/feed');
    const chunk = feedArticleChunk(res.text, submissionId);
    expect(chunk).toContain('/gallery?task=' + taskId);
  });
});

// ---------------------------------------------------------------------------
// Per-photo feed points: a memory's feed-card point count is its photo_bonus
// ONLY (no automatic base point) — consistent with the aggregate rule in
// getPoints/leaderboard. A task photo still shows base + bonus.
// ---------------------------------------------------------------------------
describe('feed per-photo points exclude a memory base point', () => {
  it('un-bonused memory shows 0; memory with photo_bonus=5 shows 5; task photo shows base(+bonus)', async () => {
    const { guestId, token } = insertGuest('Feed Points Guest');

    const plainMemory = insertSubmission({ guestId, caption: 'no bonus memory' });
    const bonusMemory = insertSubmission({ guestId, caption: 'bonus memory', photoBonus: 5 });
    const taskId = insertTask('Feed Points Task');
    const taskPhoto = insertSubmission({ guestId, taskId, caption: 'task photo' });

    const agent = await agentFor(token);
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);

    // Real expected VALUES — an un-bonused memory reading 0 fails if the base
    // POINTS_PER_PHOTO leaked back in (it would read 1).
    expect(feedPointsFor(res.text, plainMemory.submissionId)).toBe(0);
    expect(feedPointsFor(res.text, bonusMemory.submissionId)).toBe(5);
    // Task photo keeps the base: an un-bonused task photo is worth
    // POINTS_PER_PHOTO (1). This is the inversion guard — if the memory
    // branch were applied to task photos, this would read 0.
    expect(feedPointsFor(res.text, taskPhoto.submissionId)).toBe(scoring.POINTS_PER_PHOTO);
  });
});

// ---------------------------------------------------------------------------
// AC5 — /admin/photos distinguishes a memory (no task) from a task photo.
//
// Issue #259 (2026-07-19 owner-approved redesign) replaced the old
// photo-admin-card layout — which showed a literal "Memory" label plus a
// per-photo points-bonus form — with the guest-gallery-parity screen: a
// memory's tile alt text reads "a shared memory" (mirroring the guest feed,
// src/views/feed.ejs) and its By-task group heading is "Memories"; the
// per-photo points form is gone entirely (points/ranking now belong to
// issue #661, out of this screen's scope). This reasserts the same
// memory-vs-task distinction the old AC guarded, against the new markup.
// ---------------------------------------------------------------------------
describe('AC5: admin photos distinguishes a memory from a task photo', () => {
  it('a memory tile reads "a shared memory"; the By-task view groups it under "Memories"', async () => {
    const { guestId } = insertGuest('AC5 Guest');
    const { submissionId, thumbPath } = insertSubmission({ guestId, caption: 'ac5 memory' });

    const adminAgent = await makeAdminAgent(app, 'ac5-admin-pw');
    const res = await adminAgent.get('/admin/photos');
    expect(res.status).toBe(200);

    const imgAt = res.text.indexOf('src="/thumbs/' + thumbPath + '"');
    expect(imgAt).toBeGreaterThan(-1);
    const start = res.text.lastIndexOf('<figure', imgAt);
    const end = res.text.indexOf('</figure>', imgAt);
    expect(res.text.slice(start, end)).toContain('alt="a shared memory"');

    const taskViewRes = await adminAgent.get('/admin/photos?view=task');
    expect(taskViewRes.status).toBe(200);
    expect(taskViewRes.text).toContain('<h2 class="gallery-group-heading">Memories</h2>');

    // The retired per-photo points form is gone from this screen (#661 owns
    // points now).
    expect(res.text).not.toContain('action="/admin/photos/' + submissionId + '/points"');
  });
});

// ---------------------------------------------------------------------------
// AC6 — a signed-out visitor hitting GET /memories/new gets the guest-gate
// screen, not the upload form.
// ---------------------------------------------------------------------------
describe('AC6: signed-out visitor is gated', () => {
  it('GET /memories/new redirects to /join instead of showing the upload form (issue #241)', async () => {
    const res = await request(app).get('/memories/new');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/join');
    expect(res.text).not.toContain('enctype="multipart/form-data"');
  });
});

// ---------------------------------------------------------------------------
// AC7 — COMPLETIONIST is unaffected by memory rows (memories don't help or
// hurt it). The prior MOSTPHOTOS-excludes-memories case here was retired
// with the MOSTPHOTOS badge itself (#711).
// ---------------------------------------------------------------------------
describe('AC7: COMPLETIONIST is unaffected by memories', () => {
  it('COMPLETIONIST is unaffected by memories: a guest covering the only active task still qualifies after also sharing memories', () => {
    const { guestId } = insertGuest('AC7 Completionist Guest');
    const onlyActiveTask = insertTask('AC7 Completionist Task');
    // Deactivate every task from earlier tests so this guest's coverage of
    // the ONE active task above is the only thing COMPLETIONIST evaluates.
    db.prepare('UPDATE tasks SET is_active = 0 WHERE id != ?').run(onlyActiveTask);

    insertSubmission({ guestId, taskId: onlyActiveTask });
    expect(badges.METRIC_BADGES.COMPLETIONIST(guestId)).toBe(true);

    // Sharing memories afterward must not revoke it — task_id IS NULL rows
    // are invisible to COMPLETIONIST's s.task_id = t.id join.
    for (let i = 0; i < 5; i++) {
      insertSubmission({ guestId, caption: `completionist memory ${i}` });
    }
    expect(badges.METRIC_BADGES.COMPLETIONIST(guestId)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC8 — My Photos renders a memory's thumbnail + caption, no /tasks/ anchor.
// ---------------------------------------------------------------------------
describe('AC8: My Photos shows a memory with its caption and no /tasks/ anchor', () => {
  it('the memory tile has no /tasks/ anchor but does show the caption', async () => {
    const { guestId, token } = insertGuest('AC8 Guest');
    const { thumbPath } = insertSubmission({ guestId, caption: 'late night' });
    const agent = await agentFor(token);

    const res = await agent.get('/');
    expect(res.status).toBe(200);

    // Scope to this tile's <li> so the assertion cannot be satisfied by a
    // sibling task-photo tile that legitimately has a /tasks/ anchor.
    const thumbAt = res.text.indexOf('/thumbs/' + thumbPath);
    expect(thumbAt).toBeGreaterThan(-1);
    const liStart = res.text.lastIndexOf('<li class="photo-item">', thumbAt);
    const liEnd = res.text.indexOf('</li>', thumbAt);
    const tile = res.text.slice(liStart, liEnd);

    expect(tile).not.toContain('/tasks/');
    expect(tile).toContain('late night');
  });
});

// ---------------------------------------------------------------------------
// AC9 — a taken-down memory is hidden from gallery, feed, and My Photos.
// ---------------------------------------------------------------------------
describe('AC9: a taken-down memory is hidden everywhere', () => {
  it("absent from /gallery, /feed, and the owning guest's My Photos", async () => {
    const { guestId, token } = insertGuest('AC9 Guest');
    const { submissionId, thumbPath } = insertSubmission({ guestId, caption: 'ac9 memory' });
    db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(submissionId);

    const agent = await agentFor(token);

    const gallery = await agent.get('/gallery');
    expect(gallery.text).not.toContain(thumbPath);

    const galleryByTask = await agent.get('/gallery?view=task');
    expect(galleryByTask.text).not.toContain(thumbPath);

    const feed = await agent.get('/feed');
    expect(feed.text).not.toContain('id="photo-' + submissionId + '"');

    const home = await agent.get('/');
    expect(home.text).not.toContain(thumbPath);
  });
});

// ---------------------------------------------------------------------------
// AC10 — a guest whose only submission is a memory with an admin bonus of 5
// totals exactly 5 (base-count exclusion AND bonus-preservation, both hold).
// ---------------------------------------------------------------------------
describe('AC10: memory admin bonus counts; the automatic base point does not', () => {
  it('getPoints and the public leaderboard both total exactly 5', async () => {
    const { guestId, token } = insertGuest('AC10 Guest');
    insertSubmission({ guestId, caption: 'ac10 memory', photoBonus: 5 });

    expect(scoring.getPoints(guestId)).toBe(5);

    const rows = scoring.leaderboard();
    const row = rows.find((r) => r.id === guestId);
    expect(row.points).toBe(5);
    expect(row.completed).toBe(0); // the memory is not a completed task

    // Confirm the same total renders on the public leaderboard page.
    const agent = await agentFor(token);
    const res = await agent.get('/leaderboard');
    expect(res.status).toBe(200);
    expect(res.text).toContain('AC10 Guest');
  });
});

// ---------------------------------------------------------------------------
// Shared helpers for the guardrail tests (AC11/AC12).
// ---------------------------------------------------------------------------

/** POST a memory batch of N one-file uploads for the given agent. */
function postMemoryBatch(agent, n = 1) {
  let req = agent.post('/memories').field('caption', 'guardrail');
  for (let i = 0; i < n; i++) {
    req = req.attach('photos', validJpeg, {
      filename: `g-${crypto.randomUUID()}.jpg`,
      contentType: 'image/jpeg',
    });
  }
  return req;
}

function memoryRowCount(guestId) {
  return db
    .prepare(`SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ? AND task_id IS NULL`)
    .get(guestId).n;
}

function countFiles(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).length : 0;
}

// ---------------------------------------------------------------------------
// AC11 — per-guest rate limit. The Nth batch in the window succeeds; the
// (N+1)th is rejected with the literal message and inserts zero rows.
// TEST_MEMORY_RATE_MAX is pinned small at module scope so this is fast.
// ---------------------------------------------------------------------------
describe('AC11: per-guest memory rate limit', () => {
  // memory-new.ejs renders the error via EJS <%= %>, which HTML-escapes the
  // apostrophe in "that's" to &#39; — same convention AC1 uses for the
  // "They're" success flash. The guest sees the correct text; the response
  // bytes carry the escaped form.
  const RATE_MSG = 'Whoa — that&#39;s a lot of memories at once. Give it a minute and try again.';

  it('the first MEMORY_RATE_MAX batches succeed; the next is rejected with the literal and inserts no rows', async () => {
    // config.MEMORY_RATE_MAX must reflect the pinned test value.
    expect(config.MEMORY_RATE_MAX).toBe(TEST_MEMORY_RATE_MAX);

    const { guestId, token } = insertGuest('AC11 Guest');
    const agent = await agentFor(token);

    // Exactly MEMORY_RATE_MAX allowed batches, each inserting its one row.
    for (let i = 0; i < config.MEMORY_RATE_MAX; i++) {
      const res = await postMemoryBatch(agent, 1);
      expect([301, 302, 303]).toContain(res.status);
      expect(res.headers.location).toBe('/gallery');
    }
    expect(memoryRowCount(guestId)).toBe(config.MEMORY_RATE_MAX);

    // The (N+1)th batch in the window is rejected: 200 re-render with the
    // literal, and NO additional row. If the limiter were removed this would
    // be a 302 redirect with an extra row — so this assertion fails then.
    const rejected = await postMemoryBatch(agent, 1);
    expect(rejected.status).toBe(200);
    expect(rejected.text).toContain(RATE_MSG);
    expect(memoryRowCount(guestId)).toBe(config.MEMORY_RATE_MAX); // unchanged
  });

  it('a different guest under the limit still succeeds (the cap is per guest)', async () => {
    const { guestId, token } = insertGuest('AC11 Other Guest');
    const agent = await agentFor(token);
    const res = await postMemoryBatch(agent, 1);
    expect([301, 302, 303]).toContain(res.status);
    expect(memoryRowCount(guestId)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC12 — global disk-space guard, exercised via the injectable free-space
// reader (no real disk manipulation). Low space → zero rows and zero new
// files; ample space → rows inserted.
// ---------------------------------------------------------------------------
describe('AC12: disk-space guard via the injectable free-space reader', () => {
  const DISK_MSG = 'The gallery is full right now — please tell the hosts.';

  afterEach(() => {
    // Always restore the real fs.statfs reader so a stub cannot leak into
    // another test (or another suite in the same worker).
    rateLimit.setFreeSpaceReader(null);
  });

  it('low free space → rejected with the literal, zero rows, and no new files on disk', async () => {
    const { guestId, token } = insertGuest('AC12 Low-Space Guest');
    const agent = await agentFor(token);

    // Report far below MIN_FREE_DISK_BYTES.
    rateLimit.setFreeSpaceReader(() => 1024);

    const uploadsBefore = countFiles(config.UPLOADS_DIR);
    const thumbsBefore = countFiles(config.THUMBS_DIR);

    const res = await postMemoryBatch(agent, 2);

    expect(res.status).toBe(200);
    expect(res.text).toContain(DISK_MSG);
    // Behavioral: zero rows inserted. If the guard were removed this would be
    // 2 — so this assertion fails then.
    expect(memoryRowCount(guestId)).toBe(0);
    // And no residue: the originals multer wrote were cleaned up, and no
    // thumbnails were generated.
    expect(countFiles(config.UPLOADS_DIR)).toBe(uploadsBefore);
    expect(countFiles(config.THUMBS_DIR)).toBe(thumbsBefore);
  });

  it('ample free space → the same batch succeeds with rows inserted', async () => {
    const { guestId, token } = insertGuest('AC12 Ample-Space Guest');
    const agent = await agentFor(token);

    // Report well above MIN_FREE_DISK_BYTES.
    rateLimit.setFreeSpaceReader(() => config.MIN_FREE_DISK_BYTES + 10 * 1024 * 1024 * 1024);

    const res = await postMemoryBatch(agent, 2);
    expect([301, 302, 303]).toContain(res.status);
    expect(res.headers.location).toBe('/gallery');
    expect(memoryRowCount(guestId)).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Cleanup regression (plan step 9a) — when every file in a batch fails to
// thumbnail, the guest is NOT told the batch was shared.
// ---------------------------------------------------------------------------
describe('all-fail batch does not report success', () => {
  it('a batch of undecodable files inserts 0 rows and surfaces an error, not the shared flash', async () => {
    const { guestId, token } = insertGuest('All-Fail Guest');
    const agent = await agentFor(token);

    // Bytes that are not a valid image: they pass the mimetype fileFilter
    // (declared image/jpeg) and multer writes them, but photos.makeThumb
    // (sharp) throws on each, so submitMemoryBatch inserts zero rows.
    const garbage = Buffer.from('definitely not an image');
    const res = await agent
      .post('/memories')
      .field('caption', 'all fail')
      .attach('photos', garbage, { filename: 'bad-1.jpg', contentType: 'image/jpeg' })
      .attach('photos', garbage, { filename: 'bad-2.jpg', contentType: 'image/jpeg' });

    expect([301, 302, 303]).toContain(res.status);
    // Redirects to the form, NOT the gallery — nothing was shared.
    expect(res.headers.location).toBe('/memories/new');
    expect(memoryRowCount(guestId)).toBe(0);

    // Follow the redirect: an error flash, and never the success copy.
    const page = await agent.get('/memories/new');
    expect(page.text).not.toContain('Shared! They&#39;re in the gallery.');
    expect(page.text).toContain("Sorry, we couldn't save those photos.".replace("'", '&#39;'));
  });
});
