// tests/feed-window.test.js
// Covers issue #194 AC2 — the feed page is bounded and anchor resolution is
// server-side — via feed.feedWindow() directly (window math) and GET /feed
// (rendered article count, older/newer navigation, deep-anchor landing).
//
// Fixture: FEED_PAGE_SIZE + 5 visible submissions with strictly increasing
// created_at (subIds[0] oldest … subIds[last] newest), plus one taken-down
// row used to prove a moderated anchor degrades to the first page.
//
// REQUIRE ORDER: config / db / feed are required only AFTER loadApp() sets
// DATA_DIR / DB_PATH. Do not hoist requires above the loadApp() call.
'use strict';

const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let app;
let db;
let feed;
let agent;

let subIds = []; // index 0 = oldest, last = newest
let takenDownId;
let PAGE; // feed.FEED_PAGE_SIZE

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  feed = require('../src/services/feed');
  PAGE = feed.FEED_PAGE_SIZE;

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('windowtoken', 'Window Guest').lastInsertRowid;

  // PAGE + 5 visible submissions, one task each (UNIQUE guest_id/task_id),
  // minute-stepped timestamps so newest-first ordering is unambiguous.
  const total = PAGE + 5;
  for (let i = 0; i < total; i++) {
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run(`Window task ${i}`).lastInsertRowid;
    const minutes = String(i % 60).padStart(2, '0');
    const hours = String(10 + Math.floor(i / 60)).padStart(2, '0');
    const id = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`
      )
      .run(
        guestId,
        taskId,
        `w-${i}.jpg`,
        `w-${i}-t.jpg`,
        `2024-06-01 ${hours}:${minutes}:00`
      ).lastInsertRowid;
    subIds.push(id);
  }

  // A taken-down row, newest of all — must never be served or anchor a page.
  const tdTask = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Window taken-down task').lastInsertRowid;
  takenDownId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, 'w-td.jpg', 'w-td-t.jpg', 1, '2024-06-02 09:00:00')`
    )
    .run(guestId, tdTask).lastInsertRowid;

  agent = request.agent(app);
  await agent.get('/j/windowtoken');
});

const newest = () => subIds[subIds.length - 1];

// ---------------------------------------------------------------------------
// feedWindow() — the window math itself
// ---------------------------------------------------------------------------
describe('feedWindow window math', () => {
  it('no anchor: newest page of exactly FEED_PAGE_SIZE, olderFromId = the next row down', () => {
    const win = feed.feedWindow(null);
    expect(win.photos.length).toBe(PAGE);
    expect(win.photos[0].submission_id).toBe(newest());
    // 45 rows newest-first: the page holds indexes 44..5, so the next-older
    // anchor is index 4.
    expect(win.olderFromId).toBe(subIds[4]);
    expect(win.hasNewer).toBe(false);
    expect(win.newerFromId).toBeNull();
  });

  it('anchored page starts AT the anchor and runs older', () => {
    const win = feed.feedWindow(subIds[4]);
    expect(win.photos[0].submission_id).toBe(subIds[4]);
    // Only indexes 4..0 remain — 5 rows, no older page.
    expect(win.photos.length).toBe(5);
    expect(win.olderFromId).toBeNull();
  });

  it('a full FEED_PAGE_SIZE of newer rows yields a tiling newer anchor', () => {
    const win = feed.feedWindow(subIds[4]);
    expect(win.hasNewer).toBe(true);
    // Exactly PAGE rows are newer than index 4 (indexes 5..44), so the newer
    // page anchors at the farthest of them — the newest row — and tiles
    // flush against this window.
    expect(win.newerFromId).toBe(newest());
  });

  it('fewer than FEED_PAGE_SIZE newer rows means the newer page is the first page', () => {
    const win = feed.feedWindow(subIds[subIds.length - 3]);
    expect(win.hasNewer).toBe(true);
    // Two newer rows exist — no full page, so newerFromId is null ("link to
    // /feed"), which shows them without a gap.
    expect(win.newerFromId).toBeNull();
  });

  it('a taken-down anchor falls back to the first page', () => {
    const win = feed.feedWindow(takenDownId);
    expect(win.photos[0].submission_id).toBe(newest());
    expect(win.photos.map((p) => p.submission_id)).not.toContain(takenDownId);
  });

  it('a nonexistent anchor falls back to the first page', () => {
    const win = feed.feedWindow(999999);
    expect(win.photos[0].submission_id).toBe(newest());
  });
});

// ---------------------------------------------------------------------------
// GET /feed — AC2 rendered: bounded page, navigation links, deep-anchor landing
// ---------------------------------------------------------------------------
describe('GET /feed bounded page (#194 AC2)', () => {
  it('renders at most FEED_PAGE_SIZE photo articles with an older link', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    const articles = res.text.match(/<article /g) || [];
    expect(articles.length).toBe(PAGE);
    expect(res.text).toContain('href="/feed?from=' + subIds[4] + '"');
    // The oldest photo is beyond the first page.
    expect(res.text).not.toContain('id="photo-' + subIds[0] + '"');
  });

  it('a photo outside the first page still lands on a page containing it', async () => {
    const res = await agent.get('/feed?from=' + subIds[0] + '#photo-' + subIds[0]);
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="photo-' + subIds[0] + '"');
    // And a newer navigation link is present to climb back.
    expect(res.text).toContain('&larr; Newer');
  });

  it('the feed never serves originals — thumbnails only (#194 AC1)', async () => {
    const res = await agent.get('/feed');
    expect(res.text).toContain('/thumbs/w-' + (subIds.length - 1) + '-t.jpg');
    expect(res.text).not.toContain('/uploads/w-');
  });
});
