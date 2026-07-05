// tests/gallery-views.test.js
'use strict';

const { loadApp, seed } = require('./helpers/testApp');
const request = require('supertest');

let agent;
let ids;

// Seeded entity ids, set in beforeAll.
let taskId1;
let taskId2;
let guestId1;
let guestId2;
let takenDownThumbPath;

beforeAll(async () => {
  const { app, db } = loadApp();
  // seed() gives us one task + one guest baseline; we extend further below.
  ids = seed(db); // task "Selfie with the cake", guest "Seed Guest"

  // Second task.
  taskId1 = ids.taskId; // "Selfie with the cake"
  taskId2 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Toast the couple').lastInsertRowid;

  // Second guest.
  guestId1 = ids.guestId; // "Seed Guest"
  guestId2 = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('token2', 'Ava Fenwick').lastInsertRowid;

  // Submission A: guestId1 / taskId1 — inserted first, so older created_at.
  // seed() already created submission A (thumb t.jpg) for guestId1/taskId1.

  // Submission B: guestId2 / taskId2 — newer, must appear BEFORE A in recent view.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, ?, ?, 0, datetime('now', '+1 second'))`
  ).run(guestId2, taskId2, 'p2.jpg', 't2.jpg');

  // Taken-down submission — must never appear in any view.
  takenDownThumbPath = 'taken-down-thumb.jpg';
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 1)`
  ).run(guestId1, taskId2, 'taken-down-photo.jpg', takenDownThumbPath);

  agent = request.agent(app);
  // Sign in as guestId1 (seedtoken) so guest routes are available.
  await agent.get('/j/seedtoken');
});

// ---------------------------------------------------------------------------
// AC1 — default (recent) view: submission B (newer) appears before A
// ---------------------------------------------------------------------------
describe('AC1: recent view ordering', () => {
  it('B (t2.jpg) appears before A (t.jpg) in #galleryGrid markup', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);

    const indexB = res.text.indexOf('/thumbs/t2.jpg');
    const indexA = res.text.indexOf('/thumbs/t.jpg');

    // Both must be present.
    expect(indexB).toBeGreaterThan(-1);
    expect(indexA).toBeGreaterThan(-1);

    // B must appear at a lower string index (i.e. earlier in the markup).
    expect(indexB).toBeLessThan(indexA);
  });
});

// ---------------------------------------------------------------------------
// AC2 — view switcher links; grouped headings; fallback for unknown view
// ---------------------------------------------------------------------------
describe('AC2: view switcher and headings', () => {
  it('GET /gallery contains links for ?view=recent, ?view=task, and ?view=user', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain('?view=recent');
    expect(res.text).toContain('?view=task');
    expect(res.text).toContain('?view=user');
  });

  it('view=task shows a gallery-group-heading containing "Toast the couple"', async () => {
    const res = await agent.get('/gallery?view=task');
    expect(res.status).toBe(200);
    // Must have the exact element marker called out in the AC.
    expect(res.text).toContain('<h2 class="gallery-group-heading">');
    expect(res.text).toContain('Toast the couple');
  });

  it('view=user shows a gallery-group-heading containing "Ava Fenwick"', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);
    expect(res.text).toContain('<h2 class="gallery-group-heading">');
    expect(res.text).toContain('Ava Fenwick');
  });

  it('unrecognized view=banana falls back to recent (HTTP 200, no gallery-group-heading)', async () => {
    const res = await agent.get('/gallery?view=banana');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('gallery-group-heading');
  });
});

// ---------------------------------------------------------------------------
// AC3 — task filter: include/exclude correct submissions; unknown id = empty state
// ---------------------------------------------------------------------------
describe('AC3: task filter', () => {
  it('?task=<taskId2> includes t2.jpg and excludes t.jpg', async () => {
    const res = await agent.get('/gallery?task=' + taskId2);
    expect(res.status).toBe(200);
    // t2.jpg belongs to taskId2 — must be present.
    expect(res.text).toContain('/thumbs/t2.jpg');
    // t.jpg belongs to taskId1 — must be absent.
    expect(res.text).not.toContain('/thumbs/t.jpg');
  });

  it('?task=<taskId1> includes t.jpg and excludes t2.jpg', async () => {
    const res = await agent.get('/gallery?task=' + taskId1);
    expect(res.status).toBe(200);
    expect(res.text).toContain('/thumbs/t.jpg');
    expect(res.text).not.toContain('/thumbs/t2.jpg');
  });

  it('unknown task id returns HTTP 200 with empty-state message and no crash', async () => {
    const res = await agent.get('/gallery?task=999999');
    expect(res.status).toBe(200);
    // 0 photos → the "No photos yet" empty-state text must appear.
    expect(res.text).toContain('No photos');
    // No thumbnails.
    expect(res.text).not.toContain('/thumbs/');
  });
});

// ---------------------------------------------------------------------------
// AC6 — taken-down photos absent in all four views
// ---------------------------------------------------------------------------
describe('AC6: taken-down photos never appear', () => {
  it('absent from GET /gallery (recent)', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(takenDownThumbPath);
  });

  it('absent from GET /gallery?view=task', async () => {
    const res = await agent.get('/gallery?view=task');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(takenDownThumbPath);
  });

  it('absent from GET /gallery?view=user', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(takenDownThumbPath);
  });

  it('absent from GET /gallery?task=<its task id>', async () => {
    // taskId2 has the taken-down submission.
    const res = await agent.get('/gallery?task=' + taskId2);
    expect(res.status).toBe(200);
    expect(res.text).not.toContain(takenDownThumbPath);
  });
});

// ---------------------------------------------------------------------------
// AC4 (as amended by #250) — the task DETAIL page links to that task's
// gallery. The per-row "See photos" links on the /tasks list were removed by
// issue #250; the detail page is now the one path to a task's gallery view.
// (Guest routes; agent is signed in as guestId1 via seedtoken)
// ---------------------------------------------------------------------------
describe('AC4: task detail links to task gallery', () => {
  it('GET /tasks/<taskId1> contains href="/gallery?task=<taskId1>"', async () => {
    const res = await agent.get(`/tasks/${taskId1}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="/gallery?task=${taskId1}"`);
  });

  it('GET /tasks/<taskId2> contains href="/gallery?task=<taskId2>"', async () => {
    const res = await agent.get(`/tasks/${taskId2}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(`href="/gallery?task=${taskId2}"`);
  });
});
