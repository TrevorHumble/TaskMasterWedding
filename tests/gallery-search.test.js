// tests/gallery-search.test.js
// Covers issue #83 acceptance criteria — search box in the grouped gallery
// views (?view=task / ?view=user) and name/title filtering — with AC4's
// by-person ordering amended by issue #251: most-recent-photo-first
// ("recency is a party, alphabetical is a phonebook"), replacing #83's
// points-first order.
//
//   AC1 — search form + `name="q"` input present in both grouped views
//   AC2 — by-person search filters by guest name (case-insensitive substring)
//   AC3 — by-task search filters by task title (case-insensitive substring)
//   AC4 (as amended by #251) — by-person order is most-recent-photo-first
//   AC5 — blank q shows everything (same as no q)
//   AC6 — no-match search is a clean 200 empty state
//   AC7 — a guest with only a taken-down submission has no heading
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js) — the app itself is exercised via
// supertest, so no other module needs to be required directly here.
'use strict';

const { loadApp, seed, signInGuest } = require('./helpers/testApp');
const request = require('supertest');

let agent;

// Seeded entity ids, set in beforeAll.
let taskToast; // "Toast the couple"
let taskSweet; // "Sweet treat selfie"
let taskExtra; // Marcus Bell's second visible submission (points > Ava's)
let guestMarcus; // "Marcus Bell" — 2 visible submissions -> more points
let guestAva; // "Ava Fenwick" — 1 visible submission
let guestHidden; // taken-down-only guest — must never get a heading

beforeAll(async () => {
  const { app, db } = loadApp();
  // seed() gives a baseline task + guest ("Selfie with the cake" / "Seed
  // Guest") we don't otherwise reference directly, plus the "seedtoken" used
  // below to sign in.
  seed(db);

  taskToast = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Toast the couple').lastInsertRowid;
  taskSweet = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Sweet treat selfie').lastInsertRowid;
  taskExtra = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Bouquet toss').lastInsertRowid;

  guestMarcus = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('marcustoken', 'Marcus Bell').lastInsertRowid;
  guestAva = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('avatoken', 'Ava Fenwick').lastInsertRowid;
  guestHidden = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('hiddentoken', 'Hidden Guest').lastInsertRowid;

  // Marcus: two visible submissions across two tasks — but both OLDER than
  // Ava's single photo, so under #251's recency ordering his section sorts
  // second even though he has more photos (and more points).
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, 'marcus-toast.jpg', 'marcus-toast-t.jpg', 0, '2024-06-01 10:00:00')`
  ).run(guestMarcus, taskToast);
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, 'marcus-extra.jpg', 'marcus-extra-t.jpg', 0, '2024-06-01 11:00:00')`
  ).run(guestMarcus, taskExtra);

  // Ava: one visible submission, the most recent photo in the fixture.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
     VALUES (?, ?, 'ava-sweet.jpg', 'ava-sweet-t.jpg', 0, '2024-06-01 12:00:00')`
  ).run(guestAva, taskSweet);

  // Hidden guest: only a taken-down submission -> 0 visible photos, 0 points,
  // and must produce no gallery-group-heading at all (AC7).
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, 'hidden.jpg', 'hidden-t.jpg', 1)`
  ).run(guestHidden, taskSweet);

  agent = request.agent(app);
  signInGuest(app, 'seedtoken', agent);
});

// ---------------------------------------------------------------------------
// AC1 — search form present in both grouped views
// ---------------------------------------------------------------------------
describe('AC1: search form present in grouped views', () => {
  it('GET /gallery?view=user contains a GET form with a name="q" input', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<form[^>]*method="get"/i);
    expect(res.text).toMatch(/<input[^>]*name="q"/i);
  });

  it('GET /gallery?view=task contains a GET form with a name="q" input', async () => {
    const res = await agent.get('/gallery?view=task');
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/<form[^>]*method="get"/i);
    expect(res.text).toMatch(/<input[^>]*name="q"/i);
  });
});

// ---------------------------------------------------------------------------
// AC2 — by-person search filters by guest name (case-insensitive substring)
// ---------------------------------------------------------------------------
describe('AC2: by-person search filters by guest name', () => {
  it('?view=user&q=marcus includes Marcus Bell and excludes Ava Fenwick', async () => {
    const res = await agent.get('/gallery?view=user&q=marcus');
    expect(res.status).toBe(200);

    const headingMatches = res.text.match(/<h2 class="gallery-group-heading">([^<]*)<\/h2>/g) || [];
    const joined = headingMatches.join('\n');
    expect(joined).toContain('Marcus Bell');
    expect(joined).not.toContain('Ava Fenwick');
  });
});

// ---------------------------------------------------------------------------
// AC3 — by-task search filters by task title (case-insensitive substring)
// ---------------------------------------------------------------------------
describe('AC3: by-task search filters by task title', () => {
  it('?view=task&q=toast includes "Toast the couple" and excludes "Sweet treat selfie"', async () => {
    const res = await agent.get('/gallery?view=task&q=toast');
    expect(res.status).toBe(200);

    const headingMatches = res.text.match(/<h2 class="gallery-group-heading">([^<]*)<\/h2>/g) || [];
    const joined = headingMatches.join('\n');
    expect(joined).toContain('Toast the couple');
    expect(joined).not.toContain('Sweet treat selfie');
  });
});

// ---------------------------------------------------------------------------
// AC4 (as amended by #251) — by-person order is most-recent-photo-first
// ---------------------------------------------------------------------------
describe('AC4: by-person default order is most-recent-photo-first (#251)', () => {
  it('Ava Fenwick (newest photo) appears before Marcus Bell (more, older photos)', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);

    const indexMarcus = res.text.indexOf('Marcus Bell');
    const indexAva = res.text.indexOf('Ava Fenwick');

    expect(indexMarcus).toBeGreaterThan(-1);
    expect(indexAva).toBeGreaterThan(-1);
    // Recency beats volume: Marcus has two photos (and more points), but
    // Ava's single photo is newer, so her section leads.
    expect(indexAva).toBeLessThan(indexMarcus);
  });
});

// ---------------------------------------------------------------------------
// AC5 — blank q shows everything (same headings as no q at all)
// ---------------------------------------------------------------------------
describe('AC5: blank q shows everything', () => {
  it('?view=user&q= (empty) shows the same guest headings as ?view=user with no q', async () => {
    const resNoQ = await agent.get('/gallery?view=user');
    const resBlankQ = await agent.get('/gallery?view=user&q=');

    expect(resNoQ.status).toBe(200);
    expect(resBlankQ.status).toBe(200);

    const headingsOf = (text) =>
      (text.match(/<h2 class="gallery-group-heading">([^<]*)<\/h2>/g) || []).sort();

    expect(headingsOf(resBlankQ.text)).toEqual(headingsOf(resNoQ.text));
  });
});

// ---------------------------------------------------------------------------
// AC6 — no-match search is a clean empty state
// ---------------------------------------------------------------------------
describe('AC6: no-match search is a clean empty state', () => {
  it('?view=user&q=zzznomatchzzz returns 200, no headings, and the empty-state text', async () => {
    const res = await agent.get('/gallery?view=user&q=zzznomatchzzz');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('gallery-group-heading');
    expect(res.text).toContain('No photos');
  });
});

// ---------------------------------------------------------------------------
// AC7 — taken-down-only guest contributes no heading and no points
// ---------------------------------------------------------------------------
describe('AC7: taken-down-only guest is invisible', () => {
  it('Hidden Guest (only a taken_down=1 submission) has no gallery-group-heading', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('Hidden Guest');
  });
});
