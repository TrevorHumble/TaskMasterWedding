// tests/submission-lifecycle.test.js
// Issue #105 (0058): photos.js is the single writer of taken_down for
// moderation — hideSubmission/restoreSubmission flip the flag AND recompute
// auto-badges in ONE transaction, so a caller can never get one write without
// the other. This drives the ADMIN ROUTES (not the photos.js functions
// directly), because the bug this issue fixes was in the route layer: the
// routes used to run their own raw UPDATE + a separate recomputeAutoBadges
// call, pairing the two writes only by convention at each call site.
//
// Fixture: one guest with exactly 5 visible submissions (BLOOM threshold —
// see src/services/scoring.js BADGE_THRESHOLDS) plus one admin-awarded
// special badge (EARLYBIRD), so a takedown/restore of ONE submission must
// grant/revoke BLOOM while leaving EARLYBIRD untouched.
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let db;
let adminAgent;
let guestId;
let bloomBadgeId;
let earlybirdBadgeId;
let submissionIds; // 5 visible submissions

// Query whether a guest currently holds a badge by code — asserts real
// guest_badges row presence/absence, not a derived count.
function holdsBadge(guestId, badgeId) {
  const row = db
    .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
    .get(guestId, badgeId);
  return !!row;
}

function visibleCount(guestId) {
  return db
    .prepare('SELECT COUNT(*) AS c FROM submissions WHERE guest_id = ? AND taken_down = 0')
    .get(guestId).c;
}

beforeAll(async () => {
  const loaded = loadApp();
  db = loaded.db;

  // BLOOM and EARLYBIRD already exist here (#314): src/db.js's boot-heal runs
  // ensureBadgeCatalog() at module load, so loadApp() above already seeded
  // the canonical catalog this test needs (scoring.js's own "Badge catalog
  // not seeded yet — skip rather than crash" guard no longer applies).
  bloomBadgeId = db.prepare(`SELECT id FROM badges WHERE code = 'BLOOM'`).get().id;
  earlybirdBadgeId = db.prepare(`SELECT id FROM badges WHERE code = 'EARLYBIRD'`).get().id;

  guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('lifecycle-guest', 'Lifecycle Guest').lastInsertRowid;

  // 5 tasks + 5 visible submissions -> guest is AT the BLOOM threshold.
  submissionIds = [];
  for (let i = 0; i < 5; i++) {
    const taskId = db
      .prepare(`INSERT INTO tasks (title) VALUES (?)`)
      .run('Lifecycle Task ' + i).lastInsertRowid;
    const subId = db
      .prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(guestId, taskId, 'p' + i + '.jpg', 't' + i + '.jpg').lastInsertRowid;
    submissionIds.push(subId);
  }

  // Admin hand-awards the special badge directly (bypassing the route is fine
  // here — this fixture step isn't what AC3 is testing; the takedown/restore
  // calls below are).
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'admin')`
  ).run(guestId, earlybirdBadgeId);

  adminAgent = await makeAdminAgent(loaded.app);
});

describe('submission lifecycle — issue #105', () => {
  it('fixture: guest starts with 5 visible submissions and holds BLOOM + EARLYBIRD', () => {
    expect(visibleCount(guestId)).toBe(5);
    // Sanity precondition, not itself an AC: recomputeAutoBadges has not run
    // yet via the route, so grant this directly to set up the "holds it"
    // starting state the takedown route (AC1) must then revoke.
    db.prepare(
      `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')`
    ).run(guestId, bloomBadgeId);
    expect(holdsBadge(guestId, bloomBadgeId)).toBe(true);
    expect(holdsBadge(guestId, earlybirdBadgeId)).toBe(true);
  });

  it('AC1: admin takedown route drops 5 visible to 4 and revokes BLOOM', async () => {
    // admin.js mounts at '/admin' (src/app.js mountRouterIfPresent) — routes
    // inside it are written relative to /admin, e.g. POST /admin/photos/:id/takedown.
    const res = await adminAgent.post('/admin/photos/' + submissionIds[0] + '/takedown');
    // redirectWithMsg (src/routes/admin.js) always redirects 303.
    expect(res.status).toBe(303);

    expect(visibleCount(guestId)).toBe(4);
    expect(holdsBadge(guestId, bloomBadgeId)).toBe(false);
  });

  it('AC2: admin restore route brings 4 back to 5 and re-grants BLOOM', async () => {
    const res = await adminAgent.post('/admin/photos/' + submissionIds[0] + '/restore');
    expect(res.status).toBe(303);

    expect(visibleCount(guestId)).toBe(5);
    expect(holdsBadge(guestId, bloomBadgeId)).toBe(true);
  });

  it('AC3: the special badge (EARLYBIRD) is untouched by takedown or restore', async () => {
    // Re-run both operations (already exercised above) and confirm the
    // admin-awarded row never moves — recompute only ever touches
    // awarded_by = 'system' rows (scoring.recomputeAutoBadges).
    await adminAgent.post('/admin/photos/' + submissionIds[1] + '/takedown');
    expect(holdsBadge(guestId, earlybirdBadgeId)).toBe(true);

    await adminAgent.post('/admin/photos/' + submissionIds[1] + '/restore');
    expect(holdsBadge(guestId, earlybirdBadgeId)).toBe(true);
  });

  it('AC4: src/routes/admin.js contains no UPDATE submissions SET taken_down SQL', () => {
    const fs = require('fs');
    const path = require('path');
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'admin.js'), 'utf8');
    expect(source).not.toMatch(/UPDATE\s+submissions\s+SET\s+taken_down/i);
  });

  it('AC5/route contract: takedown/restore return the guest_id, not a boolean', () => {
    // Exercise photos.js directly (require after loadApp is safe — see
    // tests/photo-access.test.js for the same require-order pattern) to pin
    // the deliberate return-contract change: boolean -> guest_id.
    const photos = require('../src/services/photos');
    const result = photos.hideSubmission(submissionIds[2]);
    expect(result).toBe(guestId);
    expect(typeof result).not.toBe('boolean');

    const restored = photos.restoreSubmission(submissionIds[2]);
    expect(restored).toBe(guestId);

    // Not-found case returns undefined so a route can still guard on it.
    expect(photos.hideSubmission(999999)).toBeUndefined();
    expect(photos.restoreSubmission(999999)).toBeUndefined();
  });

  it('not-found guard: admin takedown route on a missing id redirects with "not found"', async () => {
    const res = await adminAgent.post('/admin/photos/999999/takedown');
    expect(res.status).toBe(303);
    // Location is URL-encoded by redirectWithMsg (encodeURIComponent on the
    // ?msg= value), so match against the encoded form rather than the
    // human-readable phrase.
    expect(decodeURIComponent(res.headers.location)).toMatch(/not found/i);
  });
});
