// tests/admin-stats.test.js
// Route-level coverage for GET /admin/stats (issue #1022), AC6-AC8.
//
//   AC6 — ?day=2026-08-08 renders the 24-hour dense state: two
//         .chart-cols-dense lists of 24 .chart-col each, hour 19 at
//         --v:100% in both, the other 23 at --v:0%, 24 .chart-col-label
//         elements per list with exactly 8 non-empty, no day columns, no
//         .chart-col-val, and "Saturday, Aug 8" selected.
//   AC7 — no query string renders the all-days state: two .chart-cols-few
//         lists, the pulse line, the Stats nav link, and the deleted mock
//         404s.
//   AC8 — auth guard (signed-out / non-admin guest), a malformed or
//         nonexistent ?day= falls back to all-days rather than throwing, and
//         a fresh empty database renders 200 with every section zeroed, no
//         --v:NaN% anywhere, and the "No photos yet." pulse line.
//
// REQUIRE ORDER: config / db / app are only required via loadApp() — see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS".
'use strict';

const request = require('supertest');
const { loadApp, makeAdminAgent, signInGuest } = require('./helpers/testApp');

let app;
let db;
let adminAgent;

beforeAll(async () => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  adminAgent = await makeAdminAgent(app);
});

function resetTables() {
  db.prepare('DELETE FROM comments').run();
  db.prepare('DELETE FROM likes').run();
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM guests').run();
  db.prepare('DELETE FROM tasks').run();
}

function insertGuest(token, createdAt) {
  return db
    .prepare('INSERT INTO guests (token, name, created_at) VALUES (?, ?, ?)')
    .run(token, 'Guest ' + token, createdAt).lastInsertRowid;
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

function insertSubmission(guestId, taskId, takenDown, createdAt) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(guestId, taskId, 'p.jpg', 't.jpg', takenDown ? 1 : 0, createdAt).lastInsertRowid;
}

// AC1's fixture, reused verbatim here (also tests/event-stats.test.js's own
// AC1 fixture): 3 guests total -- g1 posts 3 of Aug 8's photos (one task
// submission plus two memories, UNIQUE(guest_id, task_id) ruling out a
// second task-linked row), g2 joins on Aug 8 but posts nothing, g3 joins and
// posts once on Aug 9. 4 visible photos total; exactly 2 of the 3 guests
// posted -- AC7 below reads that as Posting 2/3 = 67%.
function seedAc1Fixture() {
  resetTables();
  const taskId = insertTask('Selfie with the cake');
  const g1 = insertGuest('r-g1', '2026-08-09 01:00:00');
  insertGuest('r-g2', '2026-08-09 02:00:00');
  insertSubmission(g1, taskId, false, '2026-08-09 03:00:00');
  insertSubmission(g1, null, false, '2026-08-09 03:30:00');
  insertSubmission(g1, null, false, '2026-08-09 04:00:00');
  const g3 = insertGuest('r-g3', '2026-08-10 01:00:00');
  insertSubmission(g3, taskId, false, '2026-08-10 02:00:00');
}

// AC2's fixture: 2 guests joining, 1 photo, all bucketing into event-local
// hour 19 on 2026-08-08.
function seedAc2Fixture() {
  resetTables();
  const taskId = insertTask('Selfie with the cake');
  const g1 = insertGuest('h-g1', '2026-08-09 01:05:00');
  insertGuest('h-g2', '2026-08-09 01:40:00');
  insertSubmission(g1, taskId, false, '2026-08-09 01:20:00');
}

describe('AC6: ?day=2026-08-08 renders the 24-hour dense state', () => {
  it('two chart-cols-dense lists of 24 columns, hour 19 at --v:100%, 8 non-empty labels, no day columns, no chart-col-val, day selected', async () => {
    seedAc2Fixture();

    const res = await adminAgent.get('/admin/stats?day=2026-08-08');
    expect(res.status).toBe(200);
    const html = res.text;

    const denseLists = html.match(/<ul class="chart-cols chart-cols-dense">[\s\S]*?<\/ul>/g) || [];
    expect(denseLists).toHaveLength(2);

    denseLists.forEach((list) => {
      // Matches the opening tag regardless of what other attributes it
      // carries (e.g. an aria-label) — a matcher pinned to the exact
      // attribute set breaks on every future attribute addition, not just
      // this one.
      const cols = list.match(/<li class="chart-col"[^>]*>/g) || [];
      expect(cols).toHaveLength(24);

      const labels = [...list.matchAll(/<span class="chart-col-label">([^<]*)<\/span>/g)].map(
        (m) => m[1]
      );
      expect(labels).toHaveLength(24);
      expect(labels.filter((l) => l !== '')).toHaveLength(8);

      // No per-bar value at this density.
      expect(list).not.toContain('chart-col-val');
    });

    // Both charts must show hour 19 fully filled, every other hour empty.
    denseLists.forEach((list) => {
      const fills = [...list.matchAll(/--v:(\d+)%/g)].map((m) => Number(m[1]));
      expect(fills).toHaveLength(24);
      expect(fills[19]).toBe(100);
      fills.forEach((v, i) => {
        if (i !== 19) expect(v).toBe(0);
      });
    });

    expect(html).not.toContain('chart-cols-few');
    expect(html).toMatch(/<option value="2026-08-08" selected>Saturday, Aug 8<\/option>/);
  });
});

describe('AC7: no query string renders the all-days state', () => {
  it('two chart-cols-few lists own-max-normalized, bands total-normalized, pulse line, Stats nav link, mock 404s', async () => {
    seedAc1Fixture();
    // AC1's fixture pins exactly one idle guest (g2, who joined but posted
    // nothing): posting reads 2 of 3 guests = 67%. That diverges from what
    // OWN-MAX normalization would produce (100%, since posting is the
    // largest band), so the assertion below actually discriminates the two
    // normalization rules rather than passing by coincidence.

    const res = await adminAgent.get('/admin/stats');
    expect(res.status).toBe(200);
    const html = res.text;

    const fewLists = html.match(/<ul class="chart-cols chart-cols-few">[\s\S]*?<\/ul>/g) || [];
    expect(fewLists).toHaveLength(2);
    fewLists.forEach((list) => {
      // See the same-shaped matcher in the AC6 test above for why this
      // tolerates attributes on the opening tag rather than pinning to none.
      const cols = list.match(/<li class="chart-col"[^>]*>/g) || [];
      // 3 rows: the default event range, Aug 7/8/9.
      expect(cols).toHaveLength(3);
      const fills = [...list.matchAll(/--v:(\d+)%/g)].map((m) => Number(m[1]));
      expect(Math.max(...fills)).toBe(100);
    });

    expect(html).not.toContain('chart-cols-dense');

    // 2 of AC1's fixture's 3 guests posted (g1 and g3; g2 joined but posted
    // nothing). Posting reads 2/3 = 67% — proof the bar is TOTAL-normalized,
    // not own-max (which would read 100%, since posting is the only nonzero
    // band here).
    const bandMatch = html.match(
      /Posting photos[\s\S]*?<span class="chart-stack-val">(\d+)<\/span>[\s\S]*?--v:(\d+)%/
    );
    expect(bandMatch).not.toBeNull();
    expect(bandMatch[1]).toBe('2');
    expect(bandMatch[2]).toBe('67');

    expect(html).toContain('Aug 7–9 · 4 photos · last one');
    expect(html).toMatch(/<a class="nav-link" href="\/admin\/stats">Stats<\/a>/);

    // The mock was never git-tracked (its own untracked-ness is what kept it
    // out of tools/visual-surface.ps1's hashed surface), so on a fresh
    // checkout this assertion is a tautology: the file was never there to
    // 404. Its worth is real but narrow -- it guards a working tree that
    // still has the file on disk from before plan step 6 deleted it (e.g. an
    // orchestrator's own uncommitted checkout mid-implementation), not a
    // checkout in general. A signed-OUT request would instead be caught by
    // guest.js's whole-router requireGuest gate (mounted at '/', ahead of the
    // 404 handler) and bounce to /join, which proves nothing about whether
    // the file itself still exists — so this check signs in a guest first,
    // the same way the pre-existing static file was actually reached.
    insertGuest('mock-check-guest', '2026-08-08 12:00:00');
    const guestAgent = signInGuest(app, 'mock-check-guest');
    const mockRes = await guestAgent.get('/admin-stats-mock.html');
    expect(mockRes.status).toBe(404);
  });
});

describe('Pinned copy-table rows (issue #1022, no dedicated AC of their own)', () => {
  it('the pulse line reads the singular "1 photo" at exactly one visible photo', async () => {
    resetTables();
    const taskId = insertTask('Selfie with the cake');
    const g1 = insertGuest('singular-g1', '2026-08-08 12:00:00');
    insertSubmission(g1, taskId, false, '2026-08-08 12:30:00');

    const res = await adminAgent.get('/admin/stats');
    expect(res.status).toBe(200);
    expect(res.text).toContain('1 photo · last one');
    expect(res.text).not.toContain('1 photos');
  });

  it('the "All <N> days" option is shown for a multi-row series and absent for a single-row one with no day selected', async () => {
    seedAc1Fixture();
    const multiRes = await adminAgent.get('/admin/stats');
    expect(multiRes.text).toMatch(/All 3 days/);

    const dbModule = require('../src/db');
    const originalConfig = dbModule.getEventConfig();
    try {
      dbModule.setEventConfig({
        timezone: originalConfig.timezone,
        startDate: '2026-08-07',
        endDate: '2026-08-07',
      });
      resetTables();
      const taskId = insertTask('Selfie with the cake');
      const g1 = insertGuest('single-g1', '2026-08-07 12:00:00');
      insertSubmission(g1, taskId, false, '2026-08-07 12:30:00');

      const singleRes = await adminAgent.get('/admin/stats');
      expect(singleRes.text).not.toMatch(/All \d+ days?/);

      // A direct ?day= link into that same one-day series still gets an
      // escape hatch back to "all days" (the dead-end fix) — the guard
      // widens to include it once a day is actually selected.
      const dayRes = await adminAgent.get('/admin/stats?day=2026-08-07');
      expect(dayRes.text).toMatch(/All 1 days/);
    } finally {
      dbModule.setEventConfig(originalConfig);
    }
  });
});

describe('AC8: guard, bad ?day= fallback, empty-database zero state', () => {
  it('a signed-out request redirects to /admin/login', async () => {
    const res = await request(app).get('/admin/stats');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('a signed-in non-admin guest is redirected to /admin/login, not shown the page', async () => {
    resetTables();
    insertGuest('guest-token', '2026-08-08 12:00:00');
    const guestAgent = signInGuest(app, 'guest-token');

    const res = await guestAgent.get('/admin/stats');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('a malformed ?day= renders the all-days state rather than throwing', async () => {
    seedAc1Fixture();
    const res = await adminAgent.get('/admin/stats?day=not-a-date');
    expect(res.status).toBe(200);
    expect(res.text).toContain('chart-cols-few');
    expect(res.text).not.toContain('chart-cols-dense');
  });

  it('a well-formed ?day= absent from the series renders the all-days state rather than an empty day chart', async () => {
    seedAc1Fixture();
    const res = await adminAgent.get('/admin/stats?day=2099-01-01');
    expect(res.status).toBe(200);
    expect(res.text).toContain('chart-cols-few');
    expect(res.text).not.toContain('chart-cols-dense');
  });

  it('a fresh empty database renders 200, every section zeroed, no --v:NaN% anywhere, "No photos yet."', async () => {
    resetTables();
    const res = await adminAgent.get('/admin/stats');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('NaN');
    expect(res.text).toContain('No photos yet.');
  });
});
