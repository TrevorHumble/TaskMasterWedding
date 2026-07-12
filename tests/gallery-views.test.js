// tests/gallery-views.test.js
// Original view-switcher/filter coverage, plus issue #251's gallery rework:
//   #251 AC2 — like-count badge on tiles with likes, none at zero
//   #251 AC3 — grouped sections cap at 6 tiles with a "+N" overlay
//   #251 AC4 — By-person order: pinned guests first, then recency
//   #251 AC6 — "Show more" pagination replaces "Older →"
'use strict';

const { loadApp, seed, makeAdminAgent, signInGuest } = require('./helpers/testApp');
const request = require('supertest');

let app;
let db;
let agent;
let ids;

// Seeded entity ids, set in beforeAll.
let taskId1;
let taskId2;
let guestId1;
let guestId2;
let takenDownThumbPath;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
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
  signInGuest(app, 'seedtoken', agent);
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

// ---------------------------------------------------------------------------
// Helpers for the #251 blocks below.
// ---------------------------------------------------------------------------

/**
 * Slice out the single <figure> tile whose <img src> names this thumb, so
 * badge assertions on one tile can never bleed into another's markup.
 */
function tileChunk(html, thumbPath) {
  const imgAt = html.indexOf('src="/thumbs/' + thumbPath + '"');
  expect(imgAt).toBeGreaterThan(-1);
  const start = html.lastIndexOf('<figure', imgAt);
  const end = html.indexOf('</figure>', imgAt);
  return html.slice(start, end);
}

/**
 * Slice out one grouped section by its heading text (from the heading's h2 to
 * the section's close), so tile-count assertions stay scoped to that group.
 */
function sectionChunk(html, heading) {
  const marker = '<h2 class="gallery-group-heading">' + heading + '</h2>';
  const start = html.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end === -1 ? html.length : end);
}

// ---------------------------------------------------------------------------
// #251 AC2 — like-count badge on tiles with likes; no badge at zero
// ---------------------------------------------------------------------------
describe('#251 AC2: like badges on recent-wall tiles', () => {
  let likedThumb;
  let unlikedThumb;

  beforeAll(() => {
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Badge task').lastInsertRowid;
    const authorId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('badge-author', 'Badge Author').lastInsertRowid;
    likedThumb = 'badge-liked-t.jpg';
    const likedId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, 'badge-liked.jpg', ?, 0)`
      )
      .run(authorId, taskId, likedThumb).lastInsertRowid;

    // Five distinct likers.
    for (let i = 0; i < 5; i++) {
      const likerId = db
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run(`badge-liker-${i}`, `Badge Liker ${i}`).lastInsertRowid;
      db.prepare(`INSERT INTO likes (submission_id, guest_id) VALUES (?, ?)`).run(likedId, likerId);
    }

    const task2 = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Badge task 2').lastInsertRowid;
    unlikedThumb = 'badge-unliked-t.jpg';
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'badge-unliked.jpg', ?, 0)`
    ).run(authorId, task2, unlikedThumb);
  });

  it('a 5-like tile carries a badge with the text 5; a 0-like tile has no badge', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);

    const liked = tileChunk(res.text, likedThumb);
    expect(liked).toContain('tile-like-badge');
    expect(liked).toMatch(/tile-like-badge[^<]*<[^>]*>[^<]*<\/span>\s*5\s*</);

    const unliked = tileChunk(res.text, unlikedThumb);
    expect(unliked).not.toContain('tile-like-badge');
  });
});

// ---------------------------------------------------------------------------
// #251 AC3 — grouped sections cap at 6 tiles, "+N" overlay when more exist
// ---------------------------------------------------------------------------
describe('#251 AC3: six-tile previews with +N overlay', () => {
  const BIG_TITLE = 'Overlay task 25';
  const SMALL_TITLE = 'Overlay task 3';

  beforeAll(() => {
    const bigTask = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run(BIG_TITLE).lastInsertRowid;
    for (let i = 0; i < 25; i++) {
      const gid = db
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run(`overlay-g-${i}`, `Overlay Guest ${i}`).lastInsertRowid;
      db.prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
         VALUES (?, ?, ?, ?, 0, '2024-05-01 08:00:00')`
      ).run(gid, bigTask, `overlay-${i}.jpg`, `overlay-${i}-t.jpg`);
    }

    const smallTask = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run(SMALL_TITLE).lastInsertRowid;
    for (let i = 0; i < 3; i++) {
      const gid = db
        .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
        .run(`small-g-${i}`, `Small Guest ${i}`).lastInsertRowid;
      db.prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
         VALUES (?, ?, ?, ?, 0, '2024-05-01 08:00:00')`
      ).run(gid, smallTask, `small-${i}.jpg`, `small-${i}-t.jpg`);
    }
  });

  it('a 25-photo task section shows exactly 6 img tiles and a "+19" overlay', async () => {
    const res = await agent.get('/gallery?view=task');
    expect(res.status).toBe(200);

    const chunk = sectionChunk(res.text, BIG_TITLE);
    const imgs = chunk.match(/<img[\s>]/g) || [];
    expect(imgs.length).toBe(6);
    expect(chunk).toContain('"tile-more">+19<');
    // The section's true total renders in the header, not the tile count.
    expect(chunk).toContain('25 photos');
  });

  it('a 3-photo task section shows exactly 3 tiles and no overlay', async () => {
    const res = await agent.get('/gallery?view=task');
    const chunk = sectionChunk(res.text, SMALL_TITLE);
    const imgs = chunk.match(/<img[\s>]/g) || [];
    expect(imgs.length).toBe(3);
    expect(chunk).not.toContain('tile-more');
  });
});

// ---------------------------------------------------------------------------
// #251 AC4 — By-person order: pinned first (via the admin checkbox), then
// most-recent-photo-first
// ---------------------------------------------------------------------------
describe('#251 AC4: pinned guest leads By person despite an older photo', () => {
  let pinnedId;
  let recentId;

  beforeAll(async () => {
    // Pinned guest with an OLD photo…
    pinnedId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('pinned-guest', 'Pinned Poppy').lastInsertRowid;
    const t1 = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Pin task old').lastInsertRowid;
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'pin-old.jpg', 'pin-old-t.jpg', 0, '2020-01-01 00:00:00')`
    ).run(pinnedId, t1);

    // …and an unpinned guest with the newest photo in the whole fixture.
    recentId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('recent-guest', 'Recent Rufus').lastInsertRowid;
    const t2 = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Pin task new').lastInsertRowid;
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'pin-new.jpg', 'pin-new-t.jpg', 0, datetime('now', '+1 hour'))`
    ).run(recentId, t2);

    // Pin Poppy through the real admin form POST (name travels with it —
    // the same form carries both fields).
    const adminAgent = await makeAdminAgent(app, 'pin-admin-pw');
    const res = await adminAgent
      .post('/admin/guests/' + pinnedId + '/edit')
      .type('form')
      .send({ name: 'Pinned Poppy', pinned: '1' });
    expect(res.status).toBe(303);
  });

  it('the admin checkbox POST persists guests.pinned = 1', () => {
    const row = db.prepare(`SELECT pinned FROM guests WHERE id = ?`).get(pinnedId);
    expect(row.pinned).toBe(1);
  });

  it('the pinned section renders first; the newest-photo guest leads the rest', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);

    // The very first person section on the page is the pinned guest.
    const firstSection = res.text.match(/data-person-section="([^"]*)"/);
    expect(firstSection).not.toBeNull();
    expect(firstSection[1]).toBe('Pinned Poppy');

    // Recency ordering holds for the unpinned rest: Rufus (newest photo)
    // appears before the older fixture guests.
    const rufusAt = res.text.indexOf('Recent Rufus');
    const avaAt = res.text.indexOf('Ava Fenwick');
    expect(rufusAt).toBeGreaterThan(-1);
    expect(avaAt).toBeGreaterThan(-1);
    expect(rufusAt).toBeLessThan(avaAt);
  });

  it('an edit POST without the checkbox unpins the guest', async () => {
    const adminAgent = await makeAdminAgent(app, 'pin-admin-pw');
    await adminAgent
      .post('/admin/guests/' + pinnedId + '/edit')
      .type('form')
      .send({ name: 'Pinned Poppy' });
    const row = db.prepare(`SELECT pinned FROM guests WHERE id = ?`).get(pinnedId);
    expect(row.pinned).toBe(0);

    // Re-pin so any later ordering assertions in this file stay valid.
    db.prepare(`UPDATE guests SET pinned = 1 WHERE id = ?`).run(pinnedId);
  });
});

// ---------------------------------------------------------------------------
// #251 AC6 — "Show more" replaces "Older →" on a multi-page recent wall
// ---------------------------------------------------------------------------
describe('#251 AC6: Show more pagination', () => {
  it('with more than one page: a "Show more" anchor exists and "Older" does not', async () => {
    // Bulk-fill past one page (GALLERY_PAGE_SIZE), scoped to a throwaway
    // guest so the cascade delete restores the table afterwards.
    const feed = require('../src/services/feed');
    const bulkGuest = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run('showmore-bulk', 'Bulk Guest').lastInsertRowid;
    for (let i = 0; i < feed.GALLERY_PAGE_SIZE + 5; i++) {
      const tid = db
        .prepare(`INSERT INTO tasks (title) VALUES (?)`)
        .run(`Show-more task ${i}`).lastInsertRowid;
      db.prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
         VALUES (?, ?, ?, ?, 0, '2019-01-01 00:00:00')`
      ).run(bulkGuest, tid, `sm-${i}.jpg`, `sm-${i}-t.jpg`);
    }

    try {
      const res = await agent.get('/gallery');
      expect(res.status).toBe(200);
      expect(res.text).toMatch(/<a[^>]*>Show more<\/a>/);
      expect(res.text).not.toContain('Older');
      // The link targets the next page of the same backend.
      expect(res.text).toContain('href="/gallery?view=recent&page=2"');
    } finally {
      db.prepare(`DELETE FROM guests WHERE id = ?`).run(bulkGuest);
      db.prepare(`DELETE FROM tasks WHERE title LIKE 'Show-more task %'`).run();
    }
  });
});
