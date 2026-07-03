// tests/gallery-search.test.js
// Covers issue #83 acceptance criteria — search box in the grouped gallery
// views (?view=task / ?view=user), name/title filtering, and points-first
// ordering for the by-person view.
//
//   AC1 — search form + `name="q"` input present in both grouped views
//   AC2 — by-person search filters by guest name (case-insensitive substring)
//   AC3 — by-task search filters by task title (case-insensitive substring)
//   AC4 — by-person default order is most-points-first
//   AC5 — blank q shows everything (same as no q)
//   AC6 — no-match search is a clean 200 empty state
//   AC7 — a guest with only a taken-down submission has no heading
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js) — the app itself is exercised via
// supertest, so no other module needs to be required directly here.
'use strict';

const { loadApp, seed } = require('./helpers/testApp');
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

  // Marcus: two visible submissions across two tasks -> 2 points.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, 'marcus-toast.jpg', 'marcus-toast-t.jpg', 0)`
  ).run(guestMarcus, taskToast);
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, 'marcus-extra.jpg', 'marcus-extra-t.jpg', 0)`
  ).run(guestMarcus, taskExtra);

  // Ava: one visible submission -> 1 point. Strictly fewer than Marcus.
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, 'ava-sweet.jpg', 'ava-sweet-t.jpg', 0)`
  ).run(guestAva, taskSweet);

  // Hidden guest: only a taken-down submission -> 0 visible photos, 0 points,
  // and must produce no gallery-group-heading at all (AC7).
  db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, 'hidden.jpg', 'hidden-t.jpg', 1)`
  ).run(guestHidden, taskSweet);

  agent = request.agent(app);
  await agent.get('/j/seedtoken');
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
// AC4 — by-person default order is most-points-first
// ---------------------------------------------------------------------------
describe('AC4: by-person default order is most-points-first', () => {
  it('Marcus Bell (2 points) appears before Ava Fenwick (1 point) with no q', async () => {
    const res = await agent.get('/gallery?view=user');
    expect(res.status).toBe(200);

    const indexMarcus = res.text.indexOf('Marcus Bell');
    const indexAva = res.text.indexOf('Ava Fenwick');

    expect(indexMarcus).toBeGreaterThan(-1);
    expect(indexAva).toBeGreaterThan(-1);
    expect(indexMarcus).toBeLessThan(indexAva);
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
