// tests/next-badge-nudge.test.js
// Issue #1057: the next unearned threshold badge (BLOOM/BOUQUET/GARDEN) now
// pins a locked row atop guest home's My Badges list, reachability-gated so
// it never repeats the broken promise issue #88 removed. scoring.
// nextThresholdBadge (src/services/scoring/badge-engine.js) is the single
// owner of the derivation; this file drives it end-to-end through real
// rendered GET / responses, the same way tests/avatar-badge-threshold.test.js
// (issue #1060) drives thresholdCompletedCount.
//
// AC1: mid-ladder, a reachable next threshold renders as the locked row,
//      first, with earned rows still following it.
// AC2: no locked row once every threshold is held, or when the next one
//      exceeds the reachable set; the boundary (exactly reachable) DOES
//      render, covering both sides of it in one describe block.
// AC3: the two zero-badge branches: the locked row alone replaces the
//      "No badges yet" paragraph when reachable, and that paragraph still
//      renders unchanged when nothing is reachable.
// AC4: the singular boundary, "1 task to", not "1 tasks to".
// AC5: a bundled-icon art_path (the stag variant's own BLOOM art) renders
//      through partials/badge-art as a medallion, not a bare <img>.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// scoring (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so scoring's prepared statements bind to the
  // temp DATA_DIR/DB_PATH (see testApp.js "REQUIRE ORDER MATTERS").
  scoring = require('../src/services/scoring');
});

// Each describe block below wants an exact, independent "how many active
// tasks exist" count (the reachable-set denominator), so it clears the
// shared db's tasks/submissions first, the same reset avatar-badge-
// threshold.test.js's AC6 uses for the same reason. Guests and badges
// persist across describes (unique guest tokens keep them from colliding).
function resetTasksAndSubmissions() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
}

// scripts/seed.js does not run in tests (tests/e2e-guest-happy-path.test.js's
// own seedBloomBadge makes the same point), so this file seeds the three
// auto-threshold catalog rows itself, matching scripts/badge-catalog.js's
// wedding-variant BADGES exactly. Idempotent: guarded by a SELECT first, so
// calling it again from a later describe is a harmless no-op (and never
// clobbers AC5's later art_path mutation on BLOOM).
function seedAutoBadges() {
  const rows = [
    { code: 'BLOOM', name: 'First Bloom', art_path: '/badges/bloom.svg', threshold: 5 },
    { code: 'BOUQUET', name: 'Bouquet Builder', art_path: '/badges/bouquet.svg', threshold: 10 },
    { code: 'GARDEN', name: 'Full Garden', art_path: '/badges/garden.svg', threshold: 15 },
  ];
  for (const b of rows) {
    const existing = db.prepare('SELECT id FROM badges WHERE code = ?').get(b.code);
    if (existing) continue;
    db.prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES (?, ?, 'auto', ?, ?, ?)`
    ).run(b.code, b.name, b.threshold, b.art_path, `Completed ${b.threshold} tasks.`);
  }
}

let guestSeq = 0;
function insertGuest(token) {
  guestSeq += 1;
  return db
    .prepare('INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, NULL)')
    .run(token, `Nudge Guest ${guestSeq}`).lastInsertRowid;
}

function insertTask(title) {
  return db.prepare('INSERT INTO tasks (title) VALUES (?)').run(title).lastInsertRowid;
}

function insertSubmission(guestId, taskId) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'p.jpg', 't.jpg', 0)`
    )
    .run(guestId, taskId).lastInsertRowid;
}

// Creates `total` distinct active tasks and has `guestId` complete the
// first `completed` of them, leaving the rest live but undone. This drives
// the reachable set (totalTasks = total + the 1 starter slot,
// src/services/scoring/points.js's starterTaskContribution) and
// thresholdCompletedCount to exact, independent numbers, without needing a
// profile photo (starter.total is always 1, only starter.done_count depends
// on avatar_path).
function seedTasks(guestId, total, completed) {
  for (let i = 0; i < total; i += 1) {
    const taskId = insertTask(`Nudge task ${guestSeq}-${i}`);
    if (i < completed) insertSubmission(guestId, taskId);
  }
}

async function homeHtml(token) {
  const agent = signInGuest(app, token);
  const res = await agent.get('/');
  expect(res.status).toBe(200);
  return res.text;
}

// ---------------------------------------------------------------------------
// AC1: mid-ladder, reachable next threshold renders first, earned rows
// still follow it.
// ---------------------------------------------------------------------------
describe('AC1: mid-ladder, a reachable next threshold renders as the locked row', () => {
  it('renders "2 tasks to First Bloom" first, with an earned row still following it', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    // A held special badge to prove "every earned badge row follows it
    // unchanged" (AC1), not just that the locked row itself renders.
    if (!db.prepare("SELECT id FROM badges WHERE code = 'EARLYBIRD'").get()) {
      db.prepare(
        `INSERT INTO badges (code, name, type, threshold, art_path, description)
         VALUES ('EARLYBIRD', 'Early Bird', 'special', NULL, '/badges/earlybird.svg', 'Arrived early.')`
      ).run();
    }

    const guestId = insertGuest('ac1-nb-guest');
    seedTasks(guestId, 4, 3); // reachable = 4 + 1 starter = 5; completed = 3
    expect(scoring.thresholdCompletedCount(guestId)).toBe(3);
    scoring.awardSpecialBadge(guestId, 'EARLYBIRD');

    const html = await homeHtml('ac1-nb-guest');

    const lockedIdx = html.indexOf('badge-item-locked');
    expect(lockedIdx).toBeGreaterThan(-1);
    expect(html).toContain('2 tasks to First Bloom');
    expect(html).toContain('Complete 5 tasks to earn it.');

    const earnedIdx = html.indexOf('href="/badge/EARLYBIRD"');
    expect(earnedIdx).toBeGreaterThan(-1);
    expect(lockedIdx).toBeLessThan(earnedIdx);
  });
});

// ---------------------------------------------------------------------------
// AC2: no locked row once every threshold is held, or the next exceeds the
// reachable set; the exact-reachable boundary DOES render (both sides of
// the boundary, one describe block).
// ---------------------------------------------------------------------------
describe('AC2: no locked row once all-earned or unreachable; the boundary renders', () => {
  it('renders no locked row once BLOOM/BOUQUET/GARDEN are all held', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    const guestId = insertGuest('ac2a-nb-guest');
    seedTasks(guestId, 15, 15);
    scoring.recomputeThresholdBadges(guestId);
    for (const code of ['BLOOM', 'BOUQUET', 'GARDEN']) {
      const held = db
        .prepare(
          `SELECT 1 FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
            WHERE gb.guest_id = ? AND b.code = ?`
        )
        .get(guestId, code);
      expect(held).toBeTruthy();
    }

    const html = await homeHtml('ac2a-nb-guest');
    expect(html).not.toContain('badge-item-locked');
  });

  it('renders no locked row when the next threshold exceeds the reachable set (3 active tasks, reachable 4)', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    const guestId = insertGuest('ac2b-nb-guest');
    seedTasks(guestId, 3, 0); // reachable = 3 + 1 = 4, BLOOM threshold 5 > 4

    const html = await homeHtml('ac2b-nb-guest');
    expect(html).not.toContain('badge-item-locked');
  });

  it('DOES render the locked row exactly at the boundary (4 active tasks, reachable 5)', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    const guestId = insertGuest('ac2c-nb-guest');
    seedTasks(guestId, 4, 0); // reachable = 4 + 1 = 5, BLOOM threshold 5 is reachable

    const html = await homeHtml('ac2c-nb-guest');
    expect(html).toContain('badge-item-locked');
    expect(html).toContain('5 tasks to First Bloom');
    expect(html).toContain('Complete 5 tasks to earn it.');
  });
});

// ---------------------------------------------------------------------------
// AC3: the two zero-badge branches.
// ---------------------------------------------------------------------------
describe('AC3: zero-badge branches, the locked row and the "No badges yet" paragraph never both render', () => {
  it('renders only the locked row, no "No badges yet" paragraph, when a next threshold is reachable', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    const guestId = insertGuest('ac3a-nb-guest');
    seedTasks(guestId, 4, 0); // reachable = 5, BLOOM reachable, zero badges held

    const html = await homeHtml('ac3a-nb-guest');
    expect(html).toContain('badge-item-locked');
    expect(html).not.toContain('No badges yet');
  });

  it('renders the "No badges yet" paragraph, no locked row, when no threshold is reachable', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    const guestId = insertGuest('ac3b-nb-guest');
    seedTasks(guestId, 2, 0); // reachable = 2 + 1 = 3, BLOOM threshold 5 unreachable

    const html = await homeHtml('ac3b-nb-guest');
    expect(html).not.toContain('badge-item-locked');
    expect(html).toContain('No badges yet, complete tasks to earn your first.');
  });
});

// ---------------------------------------------------------------------------
// AC4: the singular boundary, remaining === 1.
// ---------------------------------------------------------------------------
describe('AC4: singular boundary, remaining === 1 reads "1 task to", not "1 tasks to"', () => {
  it('renders the singular form one task short of the next threshold', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    const guestId = insertGuest('ac4-nb-guest');
    seedTasks(guestId, 4, 4); // reachable = 5, completed = 4, remaining = 1

    const html = await homeHtml('ac4-nb-guest');
    expect(html).toContain('1 task to First Bloom');
    expect(html).not.toContain('1 tasks to First Bloom');
  });
});

// ---------------------------------------------------------------------------
// AC5: a bundled-icon art_path renders through partials/badge-art as a
// medallion, still desaturated by the same locked-row rule.
// ---------------------------------------------------------------------------
describe('AC5: a bundled-icon next-badge art_path renders through partials/badge-art', () => {
  it('renders a .badge-medallion span, not a bare <img>, inside the locked row', async () => {
    resetTasksAndSubmissions();
    seedAutoBadges();
    // Point BLOOM at a bundled icon path (the stag variant's own BLOOM art,
    // scripts/badge-catalog.js's STAG_BADGES), so badgeIsIcon() is true here
    // without booting a full stag-variant app. The file exists on disk
    // regardless of VARIANT (src/services/badge-icons.js checks it at
    // require time unconditionally), so this path 404s nothing.
    db.prepare("UPDATE badges SET art_path = ? WHERE code = 'BLOOM'").run(
      '/badges/stag/icons/sports-bar.svg'
    );

    const guestId = insertGuest('ac5-nb-guest');
    seedTasks(guestId, 4, 3); // reachable = 5, completed = 3, BLOOM reachable

    const html = await homeHtml('ac5-nb-guest');
    const lockedStart = html.indexOf('badge-item-locked');
    expect(lockedStart).toBeGreaterThan(-1);
    const lockedEnd = html.indexOf('</li>', lockedStart);
    const lockedRowHtml = html.slice(lockedStart, lockedEnd);

    // partials/badge-art's icon branch renders a .badge-medallion span, not
    // the plain composed-SVG <img> the non-icon branch would.
    expect(lockedRowHtml).toContain('badge-medallion');
    expect(lockedRowHtml).not.toContain('<img');
    // alt: '' is passed for the locked row (plan step 3), so the icon glyph
    // is decorative: aria-hidden, not role="img" (badge-art.ejs's
    // accessibility branch).
    expect(lockedRowHtml).toContain('aria-hidden="true"');
  });
});
