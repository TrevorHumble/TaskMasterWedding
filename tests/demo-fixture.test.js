// tests/demo-fixture.test.js
// Issue #82 (0082): the demo fixture module (tests/helpers/demo-fixture.js)
// plus the install step (scripts/seed-demo.js) must produce a realistic,
// idempotent event data set with real image files on disk.
//
//   AC1 — 10 named guests, >= 2 avatars, mid-pack tie NOT the max, one unique top
//   AC2 — visible submissions spread across tasks/guests; taken-down thumb_path
//         never leaks into GET /gallery while a visible one does
//   AC3 — every seeded submission's photo_path/thumb_path file exists on disk
//   AC5 — seedDemo is a named, callable export
//   AC6 — idempotent: exact counts (10 guests, 18 submissions) after each of
//         two consecutive seedDemo runs
//
// REQUIRE ORDER: config / demo-fixture / seed-demo / photos are required only
// AFTER loadApp() sets DATA_DIR / DB_PATH, matching every other test in this
// suite (see tests/helpers/testApp.js).
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;
let demoFixture;
let seedDemoScript;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  config = require('../config');
  demoFixture = require('./helpers/demo-fixture');
  seedDemoScript = require('../scripts/seed-demo');
  scoring = require('../src/services/scoring');
});

// Total points per guest, read straight from the app's own scoring rule
// (src/services/scoring.js leaderboard()) so this test verifies the real
// formula instead of a copy that could silently drift from it.
function totalsByGuest() {
  return scoring.leaderboard();
}

describe('AC5: seedDemo named export', () => {
  it('exports a callable function named seedDemo', () => {
    expect(typeof demoFixture.seedDemo).toBe('function');
  });
});

describe('AC1: 10 named guests, real point spread', () => {
  beforeAll(() => {
    demoFixture.seedDemo(db);
  });

  it('produces exactly 10 guests, each with a non-empty name', () => {
    const guests = db.prepare('SELECT id, name FROM guests').all();
    expect(guests).toHaveLength(10);
    for (const g of guests) {
      expect(typeof g.name).toBe('string');
      expect(g.name.trim().length).toBeGreaterThan(0);
    }
  });

  it('at least 2 guests have a non-null avatar_path', () => {
    const withAvatar = db
      .prepare('SELECT COUNT(*) AS n FROM guests WHERE avatar_path IS NOT NULL')
      .get().n;
    expect(withAvatar).toBeGreaterThanOrEqual(2);
  });

  it('has a mid-pack tie (>= 2 guests equal, NOT the max) and exactly one unique top', () => {
    const totals = totalsByGuest();
    const points = totals.map((t) => t.points).sort((a, b) => b - a);

    const max = points[0];
    const topCount = points.filter((p) => p === max).length;
    expect(topCount).toBe(1); // exactly one clear top — this fails if two guests share first

    // Find a point value (not the max) shared by >= 2 guests.
    const counts = new Map();
    for (const p of points) counts.set(p, (counts.get(p) || 0) + 1);
    const midTieValue = [...counts.entries()].find(([value, count]) => value !== max && count >= 2);
    expect(midTieValue).toBeDefined(); // fails if no non-max value repeats
    expect(midTieValue[0]).toBeLessThan(max); // the tie is mid-pack, not tied for first
  });
});

describe('AC2: submissions spread across tasks/people; taken-down hidden from gallery', () => {
  let visibleRows;
  let takenDownRows;

  beforeAll(() => {
    demoFixture.seedDemo(db);
    visibleRows = db.prepare('SELECT * FROM submissions WHERE taken_down = 0').all();
    takenDownRows = db.prepare('SELECT * FROM submissions WHERE taken_down = 1').all();
  });

  it('visible submissions span >= 4 distinct tasks and >= 6 distinct guests', () => {
    const distinctTasks = new Set(visibleRows.map((r) => r.task_id));
    const distinctGuests = new Set(visibleRows.map((r) => r.guest_id));
    expect(distinctTasks.size).toBeGreaterThanOrEqual(4);
    expect(distinctGuests.size).toBeGreaterThanOrEqual(6);
  });

  it('at least one taken_down=1 row exists, with thumb_path distinct from every visible row', () => {
    expect(takenDownRows.length).toBeGreaterThanOrEqual(1);
    const visibleThumbs = new Set(visibleRows.map((r) => r.thumb_path));
    for (const row of takenDownRows) {
      expect(visibleThumbs.has(row.thumb_path)).toBe(false);
    }
  });

  it('GET /gallery omits every taken-down thumb_path and includes a visible one (public page)', async () => {
    // The gallery route itself (src/routes/community.js) is public — it only
    // calls attachGuest, never requireGuest. But guestRouter (mounted at '/'
    // ahead of communityRouter in src/app.js) applies requireGuest to every
    // request that reaches it, and Express tries routers in mount order — so
    // an unauthenticated request never falls through to communityRouter.
    // Sign in via a guest's private link first, exactly like tests/gallery.test.js,
    // to reach the gallery the same way a real guest would.
    // Named guest (present in DEMO_GUESTS), not LIMIT 1, so sign-in doesn't
    // depend on insert order.
    const guest = db.prepare('SELECT token FROM guests WHERE name = ?').get('Ava Martinez');
    const agent = request.agent(app);
    signInGuest(app, guest.token, agent);

    const res = await agent.get('/gallery');
    expect(res.status).toBe(200);

    // Non-vacuous: a visible thumb IS present (the check isn't just "empty page").
    const sampleVisible = visibleRows[0];
    expect(res.text).toContain(sampleVisible.thumb_path);

    // No taken-down thumb ever leaks into the public gallery body.
    for (const row of takenDownRows) {
      expect(res.text).not.toContain(row.thumb_path);
    }
  });
});

describe('AC3: install + seedDemo leaves real files on disk for every submission', () => {
  beforeAll(async () => {
    await seedDemoScript.installSamplePhotos();
    demoFixture.seedDemo(db);
  }, 30000);

  it('every submission photo_path and thumb_path exists on disk', () => {
    const rows = db.prepare('SELECT photo_path, thumb_path, taken_down FROM submissions').all();
    expect(rows.length).toBe(18);

    for (const row of rows) {
      const originalPath = path.join(config.UPLOADS_DIR, row.photo_path);
      const thumbPath = path.join(config.THUMBS_DIR, row.thumb_path);
      expect(fs.existsSync(originalPath)).toBe(true);
      expect(fs.existsSync(thumbPath)).toBe(true);
    }

    // Sanity: this includes taken-down rows too, not only visible ones.
    const takenDown = rows.filter((r) => r.taken_down === 1);
    expect(takenDown.length).toBeGreaterThanOrEqual(1);
  });

  it('every manifest avatar file exists on disk', () => {
    expect(demoFixture.MANIFEST.avatars.length).toBeGreaterThanOrEqual(1);
    for (const avatarName of demoFixture.MANIFEST.avatars) {
      const avatarPath = path.join(config.UPLOADS_DIR, avatarName);
      expect(fs.existsSync(avatarPath)).toBe(true);
    }
  });
});

describe('AC6: seedDemo is idempotent across two runs', () => {
  it('produces exactly 10 guests and 18 submissions after each of two runs', () => {
    expect(() => demoFixture.seedDemo(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(10);
    expect(db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n).toBe(18);

    expect(() => demoFixture.seedDemo(db)).not.toThrow();
    expect(db.prepare('SELECT COUNT(*) AS n FROM guests').get().n).toBe(10);
    expect(db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n).toBe(18);
  });
});
