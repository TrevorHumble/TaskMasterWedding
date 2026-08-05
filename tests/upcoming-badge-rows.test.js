// tests/upcoming-badge-rows.test.js
// Issue #1108: guest home's upcoming-badges list, above My Badges,
// supersedes issue #1057's single next-badge locked row. scoring.
// upcomingAutoBadges (src/services/scoring/badge-engine.js) is the single
// owner of the derivation; this file drives it end-to-end through real
// rendered GET / responses, the same way tests/next-badge-nudge.test.js
// drove nextThresholdBadge before this issue replaced it. That file was
// deleted in review consolidation; its unique cases (reachability,
// singular pluralization, the exact-boundary threshold) carry forward in
// this file's AC2/AC3 blocks.
//
// AC1: unearned rows only, ascending threshold order; earning a badge mid-
//      test drops its row and the badge appears in My Badges instead.
// AC2: the reachability gate (carried forward from #1057's
//      nextThresholdBadge) applies to every milestone row, not just the
//      first; the section renders nothing at all once every badge is held.
// AC3: threshold sensitivity, an admin-raised threshold changes the very
//      next render's remaining count, plus the singular "1 task to" boundary.
// AC4: the Completionist row's counter is the exact set the badge's own
//      grant check counts (challenge tasks permanently excluded, D2/#624),
//      reading 0 exactly when the badge grants.
// AC5: the points text is constant-driven (AUTO_METRIC_BADGE_POINTS,
//      CLEAN_SWEEP_BADGE_POINTS), never re-typed.
// AC6: catalog-driven, a stag-shaped catalog (no GARDEN row,
//      scripts/badge-catalog.js's STAG_BADGES) never renders a Full Garden
//      row.
// AC7: the old single next-badge locked row (badge-item-locked) is gone, and
//      nextThresholdBadge no longer exists on the scoring facade.
//
// REQUIRE ORDER: loadApp() must run before any require of config, db, or
// scoring (see tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const fs = require('fs');
const path = require('path');
const { loadApp, signInGuest } = require('./helpers/testApp');

const GUEST_CSS_PATH = path.join(__dirname, '..', 'src', 'public', 'css', 'guest.css');

let app;
let db;
let scoring;
let badges;
let AUTO_METRIC_BADGE_POINTS;
let CLEAN_SWEEP_BADGE_POINTS;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;

  // Required AFTER loadApp() so scoring's prepared statements bind to the
  // temp DATA_DIR/DB_PATH (see testApp.js "REQUIRE ORDER MATTERS"). The
  // badges catalog (BLOOM/BOUQUET/GARDEN/COMPLETIONIST, thresholds 5/10/15)
  // is already seeded by src/db.js's own boot-time ensureBadgeCatalog(db)
  // call (issue #314), no manual seeding needed here, unlike an app boot
  // path that predates that guard.
  scoring = require('../src/services/scoring');
  badges = require('../src/services/badges');
  ({ AUTO_METRIC_BADGE_POINTS, CLEAN_SWEEP_BADGE_POINTS } = require('../src/db'));
});

// Each describe block wants an exact, independent "how many active tasks
// exist" count (the reachable-set denominator), same reset tests/next-badge-
// nudge.test.js's own resetTasksAndSubmissions() uses for the same reason.
// Guests and the badge catalog persist across describes; AC3 and AC6 restore
// whatever catalog state they mutate before the end of their own test, so no
// describe below depends on running before or after another.
function resetTasksAndSubmissions() {
  db.prepare('DELETE FROM submissions').run();
  db.prepare('DELETE FROM tasks').run();
}

let guestSeq = 0;
function insertGuest(token) {
  guestSeq += 1;
  return db
    .prepare('INSERT INTO guests (token, name, avatar_path) VALUES (?, ?, NULL)')
    .run(token, `Upcoming Guest ${guestSeq}`).lastInsertRowid;
}

function insertTask(title, opts = {}) {
  const { specialDate = null, specialBonus = null, mode = null } = opts;
  const specialMode = mode || (specialDate ? 'oneday' : 'none');
  return db
    .prepare(
      `INSERT INTO tasks (title, worth, special_mode, special_date, special_bonus)
       VALUES (?, 3, ?, ?, ?)`
    )
    .run(title, specialMode, specialDate, specialBonus).lastInsertRowid;
}

function insertSubmission(guestId, taskId) {
  return db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, 'p.jpg', 't.jpg', 0)`
    )
    .run(guestId, taskId).lastInsertRowid;
}

// Creates `total` distinct ordinary (non-challenge) active tasks and has
// `guestId` complete the first `completed` of them, same shape as
// tests/next-badge-nudge.test.js's own seedTasks, driving the reachable set
// (totalTasks = total + the 1 starter slot) and thresholdCompletedCount to
// exact, independent numbers without needing a profile photo. Returns the
// inserted task ids in insertion order, so a test can complete the rest
// later.
function seedTasks(guestId, total, completed) {
  const ids = [];
  for (let i = 0; i < total; i += 1) {
    const taskId = insertTask(`Upcoming task ${guestSeq}-${i}`);
    ids.push(taskId);
    if (i < completed) insertSubmission(guestId, taskId);
  }
  return ids;
}

async function homeHtml(token) {
  const agent = signInGuest(app, token);
  const res = await agent.get('/');
  expect(res.status).toBe(200);
  return res.text;
}

// The exact label string src/views/guest-home.ejs renders for one upcoming-
// badge row, one formatter here so every assertion below matches the
// view's real markup (including the shared profile-meta-sep dot) instead of
// each test hand-restating the template.
function expectedLabel(remaining, name, points) {
  const taskWord = remaining === 1 ? 'task' : 'tasks';
  const pointWord = points === 1 ? 'point' : 'points';
  return (
    `${remaining} ${taskWord} to ${name} ` +
    `<span class="profile-meta-sep" aria-hidden="true">·</span> ` +
    `${points} ${pointWord}`
  );
}

// ---------------------------------------------------------------------------
// AC1: unearned rows only, ascending threshold order; earning a badge drops
// its row and the badge appears in My Badges instead.
// ---------------------------------------------------------------------------
describe('AC1: unearned rows only, ascending threshold order; earning a badge drops its row', () => {
  it('lists BLOOM, BOUQUET, GARDEN, COMPLETIONIST in that order when none are held, then drops BLOOM once granted', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac1-guest');
    seedTasks(guestId, 15, 0); // reachable = 16, c = 0, every threshold reachable, nothing held

    const rows = scoring.upcomingAutoBadges(guestId, 16);
    expect(rows).toEqual([
      {
        code: 'BLOOM',
        name: 'First Bloom',
        art_path: '/badges/bloom.svg',
        remaining: 5,
        points: AUTO_METRIC_BADGE_POINTS,
      },
      {
        code: 'BOUQUET',
        name: 'Bouquet Builder',
        art_path: '/badges/bouquet.svg',
        remaining: 10,
        points: AUTO_METRIC_BADGE_POINTS,
      },
      {
        code: 'GARDEN',
        name: 'Full Garden',
        art_path: '/badges/garden.svg',
        remaining: 15,
        points: AUTO_METRIC_BADGE_POINTS,
      },
      {
        code: 'COMPLETIONIST',
        name: 'Completionist',
        art_path: '/badges/completionist.svg',
        remaining: 15,
        points: CLEAN_SWEEP_BADGE_POINTS,
      },
    ]);

    const before = await homeHtml('ac1-guest');
    expect(before).toContain(expectedLabel(5, 'First Bloom', AUTO_METRIC_BADGE_POINTS));
    expect(before).not.toContain('href="/badge/BLOOM"');
    // A zero-badge guest co-renders BOTH the upcoming section (reachable
    // rows exist) AND My Badges' own "No badges yet" empty state: the two
    // sections read different things (unearned-but-reachable vs. actually
    // held), and neither one's presence implies the other's absence.
    expect(before).toContain('upcoming-badges-section');
    expect(before).toContain('No badges yet, complete tasks to earn your first.');

    // Complete BLOOM's threshold and grant it: its row disappears, the
    // badge shows in My Badges instead, and the ladder shifts up.
    const taskIds = db
      .prepare('SELECT id FROM tasks ORDER BY id ASC LIMIT 5')
      .all()
      .map((r) => r.id);
    for (const taskId of taskIds) insertSubmission(guestId, taskId);
    scoring.recomputeThresholdBadges(guestId);
    expect(scoring.thresholdCompletedCount(guestId)).toBe(5);

    const after = await homeHtml('ac1-guest');
    expect(after).not.toContain('to First Bloom');
    // BOUQUET's own remaining count moves too: completed is now 5 (the same
    // submissions that just crossed BLOOM's threshold), so BOUQUET's row
    // reads 10 - 5 = 5, not the pre-completion 10.
    expect(after).toContain(expectedLabel(5, 'Bouquet Builder', AUTO_METRIC_BADGE_POINTS));
    expect(after).toContain('href="/badge/BLOOM"');
  });
});

// ---------------------------------------------------------------------------
// AC2: the reachability gate applies per row, not just the first; the
// section is empty once everything is held or unreachable.
// ---------------------------------------------------------------------------
describe('AC2: reachability gate per row; the section is empty once everything is held', () => {
  it('omits every milestone row once its threshold exceeds the reachable set, while Completionist (ungated by reachability) still renders', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac2a-guest');
    seedTasks(guestId, 3, 0); // reachable = 4: BLOOM(5)/BOUQUET(10)/GARDEN(15) all unreachable

    const html = await homeHtml('ac2a-guest');
    expect(html).not.toContain('to First Bloom');
    expect(html).not.toContain('to Bouquet Builder');
    expect(html).not.toContain('to Full Garden');
    // AC1/AC2's text gates only the milestone rows on reachableTaskCount;
    // Completionist's own remaining count is badges.missingActiveTaskCount,
    // independent of that ceiling, so it still renders here.
    expect(html).toContain(expectedLabel(3, 'Completionist', CLEAN_SWEEP_BADGE_POINTS));
  });

  // Carried forward from tests/next-badge-nudge.test.js (deleted, issue
  // #1108 review consolidation): the one case that file covered and this
  // file did not, threshold === reachableTaskCount exactly, still renders
  // the row (the gate is `threshold <= reachableTaskCount`, not `<`).
  it('renders the row exactly at the reachable boundary (4 active tasks, reachable 5, BLOOM threshold 5)', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac2c-guest');
    seedTasks(guestId, 4, 0); // reachable = 5, BLOOM threshold 5 is exactly reachable

    const html = await homeHtml('ac2c-guest');
    expect(html).toContain(expectedLabel(5, 'First Bloom', AUTO_METRIC_BADGE_POINTS));
  });

  it('renders the section absent (no upcoming-badges-section markup) once every badge is held', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac2b-guest');
    seedTasks(guestId, 15, 15); // reachable = 16, complete every task

    scoring.recomputeThresholdBadges(guestId);
    scoring.recomputeBadges(guestId); // grants COMPLETIONIST too (full coverage)

    const html = await homeHtml('ac2b-guest');
    expect(html).not.toContain('upcoming-badges-section');
  });
});

// ---------------------------------------------------------------------------
// AC3: threshold sensitivity, an admin edit changes the very next render,
// plus the singular "1 task to" boundary.
// ---------------------------------------------------------------------------
describe('AC3: threshold sensitivity, an admin edit updates the next render, and the singular boundary', () => {
  it('shows "6 tasks to First Bloom" after the admin raises BLOOM 5 -> 6, for a guest whose c is 0', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac3a-guest');
    seedTasks(guestId, 6, 0); // reachable = 7, keeps a threshold of 6 reachable; c = 0 (no completed tasks, no avatar)

    scoring.setAutoBadgeThresholds([
      { code: 'BLOOM', n: 6 },
      { code: 'BOUQUET', n: 10 },
      { code: 'GARDEN', n: 15 },
    ]);
    try {
      const html = await homeHtml('ac3a-guest');
      expect(html).toContain(expectedLabel(6, 'First Bloom', AUTO_METRIC_BADGE_POINTS));
    } finally {
      // Restore the catalog default so later tests/describes in this file
      // (and any file run after this one against the same process, though
      // each test file gets its own temp DB) see the normal 5/10/15 ladder.
      scoring.setAutoBadgeThresholds([
        { code: 'BLOOM', n: 5 },
        { code: 'BOUQUET', n: 10 },
        { code: 'GARDEN', n: 15 },
      ]);
    }
  });

  it('renders the singular "1 task to First Bloom", never "1 tasks to"', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac3b-guest');
    seedTasks(guestId, 4, 4); // reachable = 5, completed = 4, remaining = 1

    const html = await homeHtml('ac3b-guest');
    expect(html).toContain('1 task to First Bloom');
    expect(html).not.toContain('1 tasks to First Bloom');
  });

  it('desaturates a bundled-icon badge as a .badge-medallion inside the row, the stag milestone shape', async () => {
    resetTasksAndSubmissions();
    const original = db.prepare('SELECT art_path FROM badges WHERE code = ?').get('BLOOM').art_path;
    // Point BLOOM at a bundled icon path (the stag variant's own BLOOM art,
    // scripts/badge-catalog.js's STAG_BADGES), so badgeIsIcon() is true here
    // without booting a full stag-variant app. The file exists on disk
    // regardless of VARIANT (src/services/badge-icons.js checks it at
    // require time unconditionally), so this path 404s nothing.
    db.prepare("UPDATE badges SET art_path = ? WHERE code = 'BLOOM'").run(
      '/badges/stag/icons/sports-bar.svg'
    );
    try {
      const guestId = insertGuest('ac3c-guest');
      seedTasks(guestId, 4, 3); // reachable = 5, completed = 3, BLOOM (threshold 5) reachable and unearned

      const html = await homeHtml('ac3c-guest');
      const rowStart = html.indexOf('upcoming-badge-row');
      expect(rowStart).toBeGreaterThan(-1);
      const rowEnd = html.indexOf('</li>', rowStart);
      const rowHtml = html.slice(rowStart, rowEnd);

      // partials/badge-art's icon branch renders a .badge-medallion span,
      // not the plain composed-SVG <img> the non-icon branch would; the
      // .upcoming-badge-row .badge-medallion CSS rule (guest.css) is what
      // then desaturates and sizes it exactly like the composed-SVG shape.
      expect(rowHtml).toContain('badge-medallion');
      expect(rowHtml).not.toContain('<img');
      // alt: '' is passed for every upcoming row (plan step 4), so the icon
      // glyph is decorative: aria-hidden, not role="img" (badge-art.ejs's
      // accessibility branch).
      expect(rowHtml).toContain('aria-hidden="true"');
    } finally {
      db.prepare("UPDATE badges SET art_path = ? WHERE code = 'BLOOM'").run(original);
    }
  });
});

// ---------------------------------------------------------------------------
// AC4: the Completionist counter is the exact set the badge's own grant
// check counts (challenge tasks permanently excluded, D2/#624), reading 0
// exactly when the badge grants.
// ---------------------------------------------------------------------------
describe('AC4: the Completionist counter matches the grant check exactly, challenges excluded', () => {
  it('reads "4 tasks to Completionist" with 6 of 10 ordinary tasks done and 2 live challenges untouched, then grants once the ordinary tasks are all done', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac4-guest');
    const ordinaryIds = seedTasks(guestId, 10, 6); // 10 ordinary tasks, 6 done
    insertTask('Ac4 Challenge A', { specialDate: '2026-08-20', specialBonus: 1 });
    insertTask('Ac4 Challenge B', { specialDate: '2026-08-21', specialBonus: 1 });

    expect(badges.missingActiveTaskCount(guestId)).toBe(4);

    const html = await homeHtml('ac4-guest');
    expect(html).toContain(expectedLabel(4, 'Completionist', CLEAN_SWEEP_BADGE_POINTS));

    // Complete the remaining 4 ordinary tasks: the badge grants, its row
    // disappears. The two challenges stay untouched throughout (D2/#624:
    // they never block or strip Completionist).
    for (const taskId of ordinaryIds.slice(6)) insertSubmission(guestId, taskId);
    scoring.recomputeBadges(guestId);
    expect(badges.missingActiveTaskCount(guestId)).toBe(0);

    const after = await homeHtml('ac4-guest');
    expect(after).not.toContain('to Completionist');
    expect(after).toContain('href="/badge/COMPLETIONIST"');
  });
});

// ---------------------------------------------------------------------------
// AC5: the points text is constant-driven, never re-typed.
// ---------------------------------------------------------------------------
describe('AC5: points text reads from AUTO_METRIC_BADGE_POINTS / CLEAN_SWEEP_BADGE_POINTS', () => {
  it('states the milestone points constant on a BLOOM row and the clean-sweep constant on the Completionist row', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac5-guest');
    seedTasks(guestId, 15, 0); // reachable = 16, every threshold reachable, nothing held

    const html = await homeHtml('ac5-guest');
    expect(html).toContain(expectedLabel(5, 'First Bloom', AUTO_METRIC_BADGE_POINTS));
    expect(html).toContain(expectedLabel(15, 'Completionist', CLEAN_SWEEP_BADGE_POINTS));
  });
});

// ---------------------------------------------------------------------------
// AC6: catalog-driven, a stag-shaped catalog (no GARDEN row) never renders
// a Full Garden row, never a hardcoded four.
// ---------------------------------------------------------------------------
describe('AC6: catalog-driven, a stag-shaped catalog (no GARDEN row) never renders a Full Garden row', () => {
  it('caps the list at BLOOM + BOUQUET + Completionist when the badges table has no GARDEN row', async () => {
    resetTasksAndSubmissions();
    const gardenRow = db.prepare('SELECT * FROM badges WHERE code = ?').get('GARDEN');
    db.prepare("DELETE FROM badges WHERE code = 'GARDEN'").run();
    try {
      const guestId = insertGuest('ac6-guest');
      seedTasks(guestId, 15, 0); // reachable = 16, every remaining threshold reachable

      const rows = scoring.upcomingAutoBadges(guestId, 16);
      expect(rows.map((r) => r.code)).toEqual(['BLOOM', 'BOUQUET', 'COMPLETIONIST']);

      const html = await homeHtml('ac6-guest');
      expect(html).not.toContain('to Full Garden');
      expect(html).toContain('to First Bloom');
      expect(html).toContain('to Bouquet Builder');
    } finally {
      // Restore GARDEN so no later test in this file sees a permanently
      // shrunk catalog.
      if (gardenRow) {
        db.prepare(
          `INSERT INTO badges (id, code, name, type, threshold, art_path, description)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
          gardenRow.id,
          gardenRow.code,
          gardenRow.name,
          gardenRow.type,
          gardenRow.threshold,
          gardenRow.art_path,
          gardenRow.description
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AC7: the old single next-badge locked row is gone, and nextThresholdBadge
// no longer exists on the scoring facade.
// ---------------------------------------------------------------------------
describe('AC7: the old single next-badge locked row is gone', () => {
  it('never renders badge-item-locked, and nextThresholdBadge no longer exists on the scoring facade', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('ac7-guest');
    seedTasks(guestId, 4, 0); // reachable = 5, BLOOM reachable, the old nudge would have rendered here

    const html = await homeHtml('ac7-guest');
    expect(html).not.toContain('badge-item-locked');
    expect(scoring.nextThresholdBadge).toBeUndefined();
    expect(typeof scoring.upcomingAutoBadges).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// MINOR C (issue #1108 review): the Completionist row must never render a
// vacuous "0 tasks to Completionist" for a guest who does not hold it.
// missingActiveTaskCount returns 0 both when the badge legitimately grants
// AND, vacuously, when there are zero live non-challenge tasks to count.
// The second case must never render a claimed-0 row for a badge that is
// still, in fact, unheld.
// ---------------------------------------------------------------------------
describe('MINOR C: the Completionist row is skipped, not rendered at 0, in the vacuous-zero case', () => {
  it('renders no "0 tasks to Completionist" row for a fresh guest at an event with zero live ordinary tasks', async () => {
    resetTasksAndSubmissions();
    const guestId = insertGuest('vacuous-completionist-guest');
    expect(badges.missingActiveTaskCount(guestId)).toBe(0);

    const html = await homeHtml('vacuous-completionist-guest');
    expect(html).not.toContain('to Completionist');
  });
});

// ---------------------------------------------------------------------------
// MAJOR (issue #1108 review): AC3's "desaturated small icon (in BOTH art
// shapes)" was asserted by no test: a mutation drill against
// src/public/css/guest.css showed replacing the whole declaration block
// with an inert selector still ran the suite green. Pins the exact rule the
// owner approved live on the preview 2026-08-04 (the current record hash is
// quoted in DESIGN.md's #1108 subsection; it moves on every re-persist, so
// this comment names the home of the hash, not the hash itself), the
// same read-the-served-CSS pattern tests/memory-bonus-line.test.js and
// tests/join-signup.test.js already use for their own approved rules.
// ---------------------------------------------------------------------------
describe('MAJOR fix: guest.css pins the approved desaturated small-icon declarations', () => {
  it('.upcoming-badge-row .badge-art, .upcoming-badge-row .badge-medallion sets 28px both axes, filter: grayscale(1), and opacity: 0.4', () => {
    const css = fs.readFileSync(GUEST_CSS_PATH, 'utf8');
    const ruleMatch = css.match(
      /\.upcoming-badge-row \.badge-art,\s*\.upcoming-badge-row \.badge-medallion\s*\{([^}]*)\}/
    );
    expect(ruleMatch).not.toBeNull();
    const ruleBody = ruleMatch[1];

    expect(ruleBody).toMatch(/width:\s*28px/);
    // height matters for the medallion span specifically: the img branch
    // carries width/height attributes, the span is sized by this rule alone,
    // and a wrong height renders it as an ellipse.
    expect(ruleBody).toMatch(/height:\s*28px/);
    expect(ruleBody).toMatch(/filter:\s*grayscale\(1\)/);
    expect(ruleBody).toMatch(/opacity:\s*0\.4/);
  });
});
