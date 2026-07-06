// tests/photo-feed.test.js
// Covers issue #84 acceptance criteria, as amended by issue #194 (the feed
// serves thumbnails and is bounded; originals live one tap away on /p/<id>):
//   AC1 (as amended by #194) — feed shows thumbnails newest-first, each
//        linking to /p/<id>, where the original still renders full-resolution
//   AC2 — each feed item is an anchor target (id="photo-<N>") + CSS scroll-margin-top
//   AC3 — author + caption render, with a link to the guest's profile
//   AC4 (as amended by #194) — gallery thumbnails open the feed at that
//        photo via the server-resolved anchor (/feed?from=<id>#photo-<id>)
//   AC5 — taken-down photos never appear in the feed
//   AC6 — the /p/:id permalink still resolves (200) / 404s for a missing id
//
// REQUIRE ORDER: config / db / app are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let agent;
let db;

// Submission ids seeded in beforeAll.
let idA; // oldest, visible
let idC; // newest, visible — by Marcus Bell, captioned "Sunset toast"
let guestCId; // guest id for idC's author (Marcus Bell)

beforeAll(async () => {
  const { app, db: testDb } = loadApp();
  db = testDb;

  // Community routes are behind requireGuest — sign in before testing.
  db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run('feedtoken', 'Feed Guest');
  agent = request.agent(app);
  await agent.get('/j/feedtoken');

  const guestRow = db.prepare(`SELECT id FROM guests WHERE token = ?`).get('feedtoken');
  const guestId = guestRow.id;

  guestCId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('marcustoken', 'Marcus Bell').lastInsertRowid;

  // Separate tasks so the UNIQUE (guest_id, task_id) constraint is satisfied.
  const taskId1 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Feed Task 1').lastInsertRowid;
  const taskId2 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Feed Task 2').lastInsertRowid;
  const taskId3 = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Feed Task 3').lastInsertRowid;

  // A is oldest, visible.
  idA = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down, created_at)
       VALUES (?, ?, 'a.jpg', 'at.jpg', 'Caption A', 0, '2024-01-01 10:00:00')`
    )
    .run(guestId, taskId1).lastInsertRowid;

  // Taken-down — distinct photo_path so its absence from the feed is unambiguous.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, 'takendown-x.jpg', 'takendown-x-thumb.jpg', 1, '2024-01-01 10:30:00')`
  ).run(guestId, taskId2);

  // C is newest, visible, authored by Marcus Bell with a caption.
  idC = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down, created_at)
       VALUES (?, ?, 'c.jpg', 'ct.jpg', 'Sunset toast', 0, '2024-01-01 12:00:00')`
    )
    .run(guestCId, taskId3).lastInsertRowid;
});

// ---------------------------------------------------------------------------
// AC1 (as amended by #194) — thumbnails newest-first; originals on /p/<id>
// ---------------------------------------------------------------------------
describe('AC1: feed shows thumbnails newest-first, originals one tap away', () => {
  it('GET /feed serves /thumbs/ images, never /uploads/ originals', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/thumbs/ct.jpg');
    expect(res.text).toContain('/thumbs/at.jpg');
    expect(res.text).not.toContain('/uploads/c.jpg');
    expect(res.text).not.toContain('/uploads/a.jpg');
  });

  it('each feed photo links to its detail page, where the original renders', async () => {
    const res = await agent.get('/feed');
    expect(res.text).toContain('href="/p/' + idC + '"');
    expect(res.text).toContain('href="/p/' + idA + '"');

    const detail = await agent.get('/p/' + idC);
    expect(detail.status).toBe(200);
    expect(detail.text).toContain('/uploads/c.jpg');
  });

  it('C (newest) appears before A (oldest) in the response body', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    const cIdx = res.text.indexOf('/thumbs/ct.jpg');
    const aIdx = res.text.indexOf('/thumbs/at.jpg');
    expect(cIdx).toBeGreaterThan(-1);
    expect(aIdx).toBeGreaterThan(-1);
    expect(cIdx).toBeLessThan(aIdx);
  });
});

// ---------------------------------------------------------------------------
// AC2 — each feed item is an anchor target; CSS offsets it below the header
// ---------------------------------------------------------------------------
describe('AC2: feed item is an anchor target', () => {
  it('GET /feed contains id="photo-<N>" for a visible submission', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="photo-' + idA + '"');
    expect(res.text).toContain('id="photo-' + idC + '"');
  });

  it('theme.css sets scroll-margin-top on the feed item', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'public', 'css', 'theme.css'),
      'utf8'
    );
    expect(css).toContain('scroll-margin-top');
  });
});

// ---------------------------------------------------------------------------
// AC3 — author and caption render with a link to the guest's profile
// ---------------------------------------------------------------------------
describe('AC3: author and caption render with each photo', () => {
  it('GET /feed contains "Marcus Bell", "Sunset toast", and a link to /u/<guest id>', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Marcus Bell');
    expect(res.text).toContain('Sunset toast');
    expect(res.text).toContain('href="/u/' + guestCId + '"');
  });
});

// ---------------------------------------------------------------------------
// AC4 (as amended by #194) — gallery thumbnails open the feed at that photo,
// with the server-resolved ?from anchor so the bounded page contains it
// ---------------------------------------------------------------------------
describe('AC4: gallery thumbnails link to /feed?from=<id>#photo-<id>', () => {
  it('GET /gallery contains href="/feed?from=<idA>#photo-<idA>"', async () => {
    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);
    expect(res.text).toContain('href="/feed?from=' + idA + '#photo-' + idA + '"');
  });
});

// ---------------------------------------------------------------------------
// AC5 — taken-down photos never appear
// ---------------------------------------------------------------------------
describe('AC5: taken-down photos absent from the feed', () => {
  it('GET /feed does not contain takendown-x.jpg', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('takendown-x.jpg');
  });
});

// ---------------------------------------------------------------------------
// AC6 — the /p/:id permalink still resolves
// ---------------------------------------------------------------------------
describe('AC6: /p/:id permalink still resolves', () => {
  it('GET /p/<N> for a visible submission → 200', async () => {
    const res = await agent.get('/p/' + idA);
    expect(res.status).toBe(200);
  });

  it('GET /p/999999 (nonexistent) → 404', async () => {
    const res = await agent.get('/p/999999');
    expect(res.status).toBe(404);
  });
});
