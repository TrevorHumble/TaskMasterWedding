// tests/photo-detail.test.js
// Covers issue #42 acceptance criteria:
//   AC1 — full-resolution image src + caption text
//   AC2 — prev/next ids in newest-first order; boundary absence at oldest/newest
//   AC3 — taken-down → 404; taken-down skipped in the neighbor chain
//   AC4 — nonexistent id → 404; non-numeric id → 404
//   AC5 — GET /gallery renders href="/p/<N>" for each visible submission
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let agent;
let db;

// Submission ids seeded in beforeAll.
let idA; // oldest
let idB; // middle
let idC; // newest
let idX; // taken-down, created between A and B

beforeAll(async () => {
  const { app, db: testDb } = loadApp();
  db = testDb;

  // Community routes are behind requireGuest — sign in before testing.
  db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('detailtoken', 'Detail Guest');
  agent = request.agent(app);
  await agent.get('/j/detailtoken');

  // guestId is needed for submission inserts; read it back after sign-in.
  const guestRow = db.prepare(`SELECT id FROM guests WHERE token = ?`).get('detailtoken');
  const guestId = guestRow.id;

  // Four separate tasks so the UNIQUE (guest_id, task_id) constraint is satisfied.
  const taskId1 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Detail Task 1').lastInsertRowid;
  const taskId2 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Detail Task 2').lastInsertRowid;
  const taskId3 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Detail Task 3').lastInsertRowid;
  const taskId4 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Detail Task 4').lastInsertRowid;

  // Insert A, B, C with explicit created_at so the order is deterministic.
  // A is oldest, C is newest (gallery order: C DESC, B DESC, A DESC).
  idA = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down, created_at)
       VALUES (?, ?, 'a.jpg', 'at.jpg', 'Caption A', 0, '2024-01-01 10:00:00')`
    )
    .run(guestId, taskId1).lastInsertRowid;

  // X is taken-down, sits between A and B in time so we can verify it is skipped.
  idX = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'x.jpg', 'xt.jpg', 1, '2024-01-01 10:30:00')`
    )
    .run(guestId, taskId2).lastInsertRowid;

  idB = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'b.jpg', 'bt.jpg', 0, '2024-01-01 11:00:00')`
    )
    .run(guestId, taskId3).lastInsertRowid;

  idC = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'c.jpg', 'ct.jpg', 0, '2024-01-01 12:00:00')`
    )
    .run(guestId, taskId4).lastInsertRowid;
});

// ---------------------------------------------------------------------------
// AC1 — full-resolution image src and caption text
// ---------------------------------------------------------------------------
describe('AC1: full-resolution image + caption', () => {
  it('response body contains /uploads/a.jpg (not /thumbs/)', async () => {
    const res = await agent.get('/p/' + idA);
    expect(res.status).toBe(200);
    expect(res.text).toContain('/uploads/a.jpg');
    expect(res.text).not.toContain('/thumbs/at.jpg');
  });

  it('response body contains the caption text', async () => {
    const res = await agent.get('/p/' + idA);
    expect(res.status).toBe(200);
    expect(res.text).toContain('Caption A');
  });
});

// ---------------------------------------------------------------------------
// AC2 — prev/next in newest-first order; boundary absence
// ---------------------------------------------------------------------------
describe('AC2: prev/next ordering', () => {
  it('GET /p/<B> has next href /p/<A> (older) and prev href /p/<C> (newer)', async () => {
    const res = await agent.get('/p/' + idB);
    expect(res.status).toBe(200);
    // next = older = A
    expect(res.text).toContain('href="/p/' + idA + '"');
    // prev = newer = C
    expect(res.text).toContain('href="/p/' + idC + '"');
  });

  it('next href targets A (not C) — fails if next/prev are swapped', async () => {
    const res = await agent.get('/p/' + idB);
    expect(res.status).toBe(200);
    // The template renders prev (newer, C) before next (older, A) in markup order.
    const prevIdx = res.text.indexOf('href="/p/' + idC + '"');
    const nextIdx = res.text.indexOf('href="/p/' + idA + '"');
    expect(prevIdx).toBeGreaterThan(-1);
    expect(nextIdx).toBeGreaterThan(-1);
    // prev appears first in markup; next appears second.
    expect(prevIdx).toBeLessThan(nextIdx);
  });

  it('GET /p/<C> (newest) has no "prev" anchor (nothing newer exists)', async () => {
    const res = await agent.get('/p/' + idC);
    expect(res.status).toBe(200);
    // No clickable anchor for prev — the disabled span has no href.
    expect(res.text).not.toContain('js-photo-prev');
  });

  it('GET /p/<A> (oldest) has no "next" anchor (nothing older exists)', async () => {
    const res = await agent.get('/p/' + idA);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('js-photo-next');
  });
});

// ---------------------------------------------------------------------------
// AC3 — taken-down → 404; taken-down skipped in the neighbor chain
// ---------------------------------------------------------------------------
describe('AC3: taken-down handling', () => {
  it('GET /p/<taken-down id> → 404', async () => {
    const res = await agent.get('/p/' + idX);
    expect(res.status).toBe(404);
  });

  it('GET /p/<B> skips taken-down X: next href is /p/<A>, not /p/<X>', async () => {
    // X sits between A and B in time (A < X < B). From B, next-older should
    // skip X (taken-down) and land on A.
    const res = await agent.get('/p/' + idB);
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/p/' + idA + '"');
    expect(res.text).not.toContain('href="/p/' + idX + '"');
  });
});

// ---------------------------------------------------------------------------
// AC4 — nonexistent and non-numeric ids → 404
// ---------------------------------------------------------------------------
describe('AC4: 404 for nonexistent and non-numeric ids', () => {
  it('GET /p/999999 → 404', async () => {
    const res = await agent.get('/p/999999');
    expect(res.status).toBe(404);
  });

  it('GET /p/not-a-number → 404', async () => {
    const res = await agent.get('/p/not-a-number');
    expect(res.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// AC5 — gallery renders href="/feed#photo-<N>" for each visible submission
// ---------------------------------------------------------------------------
describe('AC5: gallery thumbnails open the feed at that photo', () => {
  it('GET /gallery contains href="/feed#photo-<idA>"', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/feed#photo-' + idA + '"');
  });

  it('GET /gallery contains href="/feed#photo-<idC>" (newest)', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/feed#photo-' + idC + '"');
  });

  it('GET /gallery does not link to taken-down submission X', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('href="/feed#photo-' + idX + '"');
  });
});
