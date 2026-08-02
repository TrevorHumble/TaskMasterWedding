// tests/profile-photo-paging.test.js
// Covers issue #1004 — /u/:guestId now hands out a bounded first page of a
// guest's visible photos (feed.GALLERY_PAGE_SIZE, 60) with a click-activated
// "Show more" control, instead of rendering the guest's entire history in
// one unbounded response.
//
// Phase 1 (owner-approved live on the seeded preview 2026-08-02, frozen):
// src/views/public-profile.ejs's grid/nav markup and its /js/gallery-more.js
// include, unchanged in shape from that approval. This file, plus the
// feed.js/community.js wiring, is phase 2 — transcribing the approved
// screen's behavior into route + service + tests per the issue's
// implementation plan steps 1-4.
//
// REQUIRE ORDER: config/db/app/feed are required only AFTER loadApp() sets
// DATA_DIR/DB_PATH (same pattern as tests/community-branches.test.js and
// tests/feed.test.js) — one loadApp() call, shared app/db for every describe
// below, each seeding its own guest so describes never collide.
//
//   feed.guestPhotosPage(guestId, page) — unit, direct against the shared db
//   (prior art: tests/feed.test.js exercises feed.recentPage/guestPhotos the
//   same way):
//     AC6 — a NaN/0/negative/float page argument floors to page 1; an
//     above-range page argument clamps to the last page; the clamped page
//     number is reported back alongside the rows.
//
//   Server-rendered shape — supertest against the real /u/:guestId route
//   (prior art: tests/gallery-show-more.test.js's own server-rendered
//   section, and tests/helpers/testApp.js's signInGuest for the session —
//   GET /j/:token is retired):
//     AC1 — 89-photo guest, page 1: exactly 60 tiles, .show-more link to
//     ?page=2.
//     AC2 — same guest, page 2: exactly the remaining 29 tiles, no
//     .show-more nav.
//     AC3 — a 12-photo guest: all 12 tiles, no .show-more nav.
//     AC4 — page=99 clamps down to the last (29-tile) page; page=0, -3, and
//     abc all floor to page 1 (60 tiles) — every case is a 200 with a
//     populated grid, never the empty-state copy.
//     AC5 — a guest with 0 photos reads as empty ("No photos shared yet.")
//     at any ?page= value, with no .show-more nav.
'use strict';

const crypto = require('crypto');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let feed;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  feed = require('../src/services/feed');
});

function insertGuest(name) {
  const token = `profile-paging-${crypto.randomUUID()}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, name).lastInsertRowid;
  return { guestId, token };
}

// submissions carries a UNIQUE(guest_id, task_id) constraint (one submission
// per guest per task), so each photo needs its own task — same shape as
// tests/gallery-show-more.test.js's server-rendered seed.
function insertVisibleSubmissions(guestId, count, prefix) {
  const insertTask = db.prepare(`INSERT INTO tasks (title) VALUES (?)`);
  const insertSubmission = db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  );
  for (let i = 0; i < count; i++) {
    const taskId = insertTask.run(`${prefix} task ${i}`).lastInsertRowid;
    insertSubmission.run(guestId, taskId, `${prefix}-${i}.jpg`, `${prefix}-${i}-t.jpg`);
  }
}

async function agentFor(token) {
  const agent = request.agent(app);
  signInGuest(app, token, agent);
  return agent;
}

function tileCount(html) {
  return (html.match(/class="gallery-item"/g) || []).length;
}

describe('feed.guestPhotosPage(guestId, page): AC6 — the clamp lives in the service', () => {
  let guestId;
  const TOTAL_PHOTOS = 89;

  beforeAll(() => {
    ({ guestId } = insertGuest('Paging Unit Guest'));
    insertVisibleSubmissions(guestId, TOTAL_PHOTOS, 'paging-unit');
  });

  it('a positive in-range page returns that page, unclamped', () => {
    const result = feed.guestPhotosPage(guestId, 1);
    expect(result.page).toBe(1);
    expect(result.total).toBe(TOTAL_PHOTOS);
    expect(result.totalPages).toBe(2);
    expect(result.photos.length).toBe(feed.GALLERY_PAGE_SIZE);
  });

  it.each([
    ['NaN', NaN],
    ['zero', 0],
    ['negative', -3],
    ['a float', 1.5],
  ])('a %s page argument floors to page 1', (_label, page) => {
    const result = feed.guestPhotosPage(guestId, page);
    expect(result.page).toBe(1);
    expect(result.photos.length).toBe(feed.GALLERY_PAGE_SIZE);
  });

  it('a page beyond the last page clamps down to it and reports the clamped number', () => {
    const result = feed.guestPhotosPage(guestId, 99);
    expect(result.page).toBe(2);
    expect(result.totalPages).toBe(2);
    expect(result.photos.length).toBe(TOTAL_PHOTOS - feed.GALLERY_PAGE_SIZE);
  });
});

describe('GET /u/:guestId: paging behavior (AC1, AC2, AC4)', () => {
  let guestId;
  let agent;
  const TOTAL_PHOTOS = 89;

  beforeAll(async () => {
    expect(feed.GALLERY_PAGE_SIZE).toBe(60);
    let token;
    ({ guestId, token } = insertGuest('Profile Paging Server Guest'));
    insertVisibleSubmissions(guestId, TOTAL_PHOTOS, 'profile-paging-server');
    agent = await agentFor(token);
  });

  it('AC1 — page 1 renders exactly GALLERY_PAGE_SIZE tiles and a Show more link to page=2', async () => {
    const res = await agent.get(`/u/${guestId}`);
    expect(res.status).toBe(200);
    expect(tileCount(res.text)).toBe(60);
    expect(res.text).toContain(`href="/u/${guestId}?page=2"`);
    expect(res.text).toContain('/js/gallery-more.js');
  });

  it('AC2 — page 2 renders exactly the remaining tiles and no Show more nav', async () => {
    const res = await agent.get(`/u/${guestId}?page=2`);
    expect(res.status).toBe(200);
    expect(tileCount(res.text)).toBe(TOTAL_PHOTOS - 60);
    expect(res.text).not.toContain('class="show-more"');
    expect(res.text).not.toContain('/js/gallery-more.js');
  });

  it('AC4 — page=99 clamps down to the last (29-tile) page, still a populated 200', async () => {
    const res = await agent.get(`/u/${guestId}?page=99`);
    expect(res.status).toBe(200);
    expect(tileCount(res.text)).toBe(TOTAL_PHOTOS - 60);
    expect(res.text).not.toContain('No photos shared yet.');
  });

  it.each(['0', '-3', 'abc'])(
    'AC4 — ?page=%s floors to page 1 (60 tiles), never an empty page',
    async (pageParam) => {
      const res = await agent.get(`/u/${guestId}?page=${pageParam}`);
      expect(res.status).toBe(200);
      expect(tileCount(res.text)).toBe(60);
      expect(res.text).not.toContain('No photos shared yet.');
    }
  );
});

describe('GET /u/:guestId: a short profile is unchanged (AC3)', () => {
  let guestId;
  let agent;
  const TOTAL_PHOTOS = 12;

  beforeAll(async () => {
    let token;
    ({ guestId, token } = insertGuest('Profile Paging Short Guest'));
    insertVisibleSubmissions(guestId, TOTAL_PHOTOS, 'profile-paging-short');
    agent = await agentFor(token);
  });

  it('all 12 tiles render and no Show more nav is present', async () => {
    const res = await agent.get(`/u/${guestId}`);
    expect(res.status).toBe(200);
    expect(tileCount(res.text)).toBe(TOTAL_PHOTOS);
    expect(res.text).not.toContain('class="show-more"');
    expect(res.text).not.toContain('/js/gallery-more.js');
  });
});

describe('GET /u/:guestId: a guest with no photos reads as empty, not broken (AC5)', () => {
  let guestId;
  let agent;

  beforeAll(async () => {
    let token;
    ({ guestId, token } = insertGuest('Profile Paging Empty Guest'));
    agent = await agentFor(token);
  });

  it.each([undefined, '1', '2', '0', 'abc'])(
    '"No photos shared yet." renders and no Show more nav appears at ?page=%s',
    async (pageParam) => {
      const url = pageParam === undefined ? `/u/${guestId}` : `/u/${guestId}?page=${pageParam}`;
      const res = await agent.get(url);
      expect(res.status).toBe(200);
      expect(res.text).toContain('No photos shared yet.');
      expect(res.text).not.toContain('class="show-more"');
      expect(res.text).not.toContain('/js/gallery-more.js');
    }
  );
});
