// tests/myphotos-photo-links.test.js
// Covers issue #613 acceptance criteria — the "My Photos" section of the
// guest's own home page (src/views/guest-home.ejs, GET '/'):
//   AC1 — a task-linked thumbnail's anchor points at /p/:id, not /tasks/:task_id
//   AC2 — a memory thumbnail (task_id IS NULL) is wrapped in an anchor to
//         /p/:id (previously it had no link at all)
//   AC3 — following that anchor (GET /p/:id) renders the photo detail view
//         with HTTP 200, for both a task-linked and a memory submission
//   AC4 — the anchor carries an accessible name: the task title for a
//         task-linked photo, or the caption / "a shared memory" fallback for
//         a memory
//
// REQUIRE ORDER: config / db / app are required only via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let agent;

// Submission ids seeded in beforeAll.
let taskSubId; // task-linked, task title "My Photos Task"
let taskId;
let memorySubId; // memory (task_id NULL), caption "A fun day"
let blankMemorySubId; // memory with NO caption — exercises the "a shared memory" fallback

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('myphotos-token', 'Photo Link Guest');
  agent = request.agent(app);
  signInGuest(app, 'myphotos-token', agent);

  const guestId = db.prepare(`SELECT id FROM guests WHERE token = ?`).get('myphotos-token').id;

  taskId = db.prepare(`INSERT INTO tasks (title) VALUES (?)`).run('My Photos Task').lastInsertRowid;

  taskSubId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'task-original.jpg', 'task-thumb.jpg', 0, '2024-01-01 12:00:00')`
    )
    .run(guestId, taskId).lastInsertRowid;

  memorySubId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down, created_at)
       VALUES (?, NULL, 'memory-original.jpg', 'memory-thumb.jpg', 'A fun day', 0, '2024-01-01 13:00:00')`
    )
    .run(guestId).lastInsertRowid;

  blankMemorySubId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, NULL, 'blank-original.jpg', 'blank-thumb.jpg', 0, '2024-01-01 14:00:00')`
    )
    .run(guestId).lastInsertRowid;
});

describe('AC1: task-linked thumbnail points at the photo', () => {
  test('the anchor href is /p/<id>, not /tasks/<task_id>', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    expect(res.text).toContain(`href="/p/${taskSubId}"`);
    // The real assertion this would fail on if AC1 regressed: the old
    // /tasks/:task_id anchor target is gone from the page entirely.
    expect(res.text).not.toContain(`href="/tasks/${taskId}"`);
  });
});

describe('AC2: memory thumbnail becomes clickable', () => {
  test('a memory (task_id IS NULL) thumbnail is wrapped in an anchor to /p/<id>', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    expect(res.text).toContain(`href="/p/${memorySubId}"`);
  });
});

describe('AC3: the link opens the photo', () => {
  test('GET /p/<id> for the task-linked submission renders 200', async () => {
    const res = await agent.get(`/p/${taskSubId}`);
    expect(res.status).toBe(200);
  });

  test('GET /p/<id> for the memory submission renders 200', async () => {
    const res = await agent.get(`/p/${memorySubId}`);
    expect(res.status).toBe(200);
  });
});

describe('AC4: the link has an accessible name', () => {
  test('a task-linked anchor is named after the task title', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    expect(res.text).toContain(`href="/p/${taskSubId}" aria-label="View photo for My Photos Task"`);
  });

  test('a memory anchor with a caption is named after the caption', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    expect(res.text).toContain(`href="/p/${memorySubId}" aria-label="View photo for A fun day"`);
  });

  test('a memory anchor with no caption falls back to "a shared memory"', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    expect(res.text).toContain(
      `href="/p/${blankMemorySubId}" aria-label="View photo for a shared memory"`
    );
  });
});
