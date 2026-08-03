// tests/myphotos-photo-links.test.js
// Covers issue #613 acceptance criteria, as amended by issue #952 (gallery
// parity — a My Photos tile opens the scoped feed, not the old /p/:id
// dead end) — the "My Photos" section of the guest's own home page
// (src/views/guest-home.ejs, GET '/'):
//   AC1 — a task-linked thumbnail's anchor points at the feed scoped to this
//         guest's own photos (/feed?from=:id&scope=u<guestId>#photo-:id),
//         not /tasks/:task_id
//   AC2 — a memory thumbnail (task_id IS NULL) is wrapped in the same scoped
//         feed anchor (previously it had no link at all)
//   AC3 — the underlying photo permalink (GET /p/:id) still renders 200 for
//         both a task-linked and a memory submission (unaffected by AC1/AC2 —
//         the feed card's own photo link still targets /p/:id)
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
let guestId; // owner of every submission above — the scope=u<guestId> id.

/** The scoped feed href a My Photos tile carries for submission `id`. The
 * rendered anchor HTML-escapes the query separators to &amp; (approved
 * markup, issue #952 AC2), and carries origin=home (issue #954) so the
 * scoped feed's back link returns to this My Photos page. */
function scopedFeedHref(id) {
  return `href="/feed?from=${id}&amp;scope=u${guestId}&amp;origin=home#photo-${id}"`;
}

/** Slice from a tile's own opening <a ...> through its closing '>', so an
 * aria-label assertion can be scoped to the SAME anchor the href marker
 * identifies rather than matching a coincidental later tile. */
function tileAnchorChunk(html, hrefMarker) {
  const start = html.indexOf(hrefMarker);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('>', start);
  return html.slice(start, end === -1 ? html.length : end);
}

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run(
    'myphotos-token',
    'Photo Link Guest'
  );
  agent = request.agent(app);
  signInGuest(app, 'myphotos-token', agent);

  guestId = db.prepare(`SELECT id FROM guests WHERE token = ?`).get('myphotos-token').id;

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

describe('AC1: task-linked thumbnail opens the scoped feed', () => {
  test('the anchor href is the feed scoped to this guest, not /tasks/<task_id>', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    expect(res.text).toContain(scopedFeedHref(taskSubId));
    // The real assertion this would fail on if AC1 regressed: the old
    // /tasks/:task_id anchor target is gone from the page entirely.
    expect(res.text).not.toContain(`href="/tasks/${taskId}"`);
  });
});

describe('AC2: memory thumbnail becomes clickable', () => {
  test('a memory (task_id IS NULL) thumbnail is wrapped in an anchor to the scoped feed', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    expect(res.text).toContain(scopedFeedHref(memorySubId));
  });
});

describe('AC3: the underlying photo permalink still resolves', () => {
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

    const chunk = tileAnchorChunk(res.text, scopedFeedHref(taskSubId));
    expect(chunk).toContain('aria-label="View photo for My Photos Task"');
  });

  test('a memory anchor with a caption is named after the caption', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    const chunk = tileAnchorChunk(res.text, scopedFeedHref(memorySubId));
    expect(chunk).toContain('aria-label="View photo for A fun day"');
  });

  test('a memory anchor with no caption falls back to "a shared memory"', async () => {
    const res = await agent.get('/');
    expect(res.status).toBe(200);

    const chunk = tileAnchorChunk(res.text, scopedFeedHref(blankMemorySubId));
    expect(chunk).toContain('aria-label="View photo for a shared memory"');
  });
});
