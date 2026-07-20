// tests/guest-delete-badge-recompute.test.js
// Issue #715: POST /admin/guests/:id/delete cascades the deleted guest's own
// rows away but, before this fix, recomputed nothing — so a transferable
// badge (MOSTPHOTOS/MOSTLIKED) held solely by the deleted guest sat unheld
// until some later, unrelated event happened to trigger a recompute. These
// tests prove the fix lives in the ROUTE, not in some helper the test calls
// itself: every assertion hits the admin delete route through the agent and
// checks the resulting guest_badges state WITHOUT ever calling
// scoring.recompute* in the test body (issue implementation plan step 3) — a
// precondition of "this guest already holds MOSTPHOTOS" is built with a
// direct guest_badges insert, not by asking the engine to compute it first
// (same convention as tests/task-badge-recompute.test.js's
// grantCompletionistDirect).
//
// Both describe blocks share ONE temp DB (loadApp() runs once in beforeAll —
// a second loadApp() in the same file would silently reuse the cached
// require('../../src/app'), NOT create an isolated fresh one, per
// tests/task-badge-recompute.test.js's note). AC2 therefore wipes submissions
// and guest_badges at its own start so AC1's leftover state can never leak
// into its "no other guest's row changed" equality check.
'use strict';

const { loadApp, makeAdminAgent } = require('./helpers/testApp');

let db;
let adminAgent;
let mostPhotosBadgeId;

let guestTokenSeq = 0;
function makeGuest(name) {
  guestTokenSeq += 1;
  const token = `guest-delete-recompute-${guestTokenSeq}`;
  return db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, name)
    .lastInsertRowid;
}

function makeTask(title) {
  return db.prepare('INSERT INTO tasks (title, is_active) VALUES (?, 1)').run(title)
    .lastInsertRowid;
}

// Inserts N visible, task-linked submissions for guestId — the exact shape
// mostPhotosHolders() (src/services/badges.js) counts: taken_down = 0 AND
// task_id IS NOT NULL. Each submission gets its own task row so "N visible
// task submissions" cannot be misread as one task submitted N times.
let photoSeq = 0;
function submitN(guestId, n) {
  for (let i = 0; i < n; i += 1) {
    photoSeq += 1;
    const taskId = makeTask(`Delete-recompute task ${photoSeq}`);
    const photo = `gdrp${photoSeq}.jpg`;
    const thumb = `gdrt${photoSeq}.jpg`;
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    ).run(guestId, taskId, photo, thumb);
  }
}

// Directly grants MOSTPHOTOS to a guest via a raw guest_badges insert —
// deliberately NOT scoring.recomputeTransferableBadges — so a test can set up
// the "guest already holds it" precondition without the test itself calling
// any recompute* function (the whole point of this suite is proving the
// ROUTE's call to recomputeTransferableBadges is what transfers the badge).
function grantMostPhotosDirect(guestId) {
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, 'system')`
  ).run(guestId, mostPhotosBadgeId);
}

function heldCodes(guestId) {
  return db
    .prepare(
      `SELECT b.code FROM guest_badges gb JOIN badges b ON b.id = gb.badge_id
        WHERE gb.guest_id = ? ORDER BY b.code ASC`
    )
    .all(guestId)
    .map((r) => r.code);
}

beforeAll(async () => {
  const loaded = loadApp();
  db = loaded.db;
  adminAgent = await makeAdminAgent(loaded.app);
  // Seed the real catalog so MOSTPHOTOS exists, mirroring
  // tests/task-badge-recompute.test.js.
  require('../scripts/seed.js');
  mostPhotosBadgeId = db.prepare('SELECT id FROM badges WHERE code = ?').get('MOSTPHOTOS').id;
});

describe('AC1: deleting the sole MOSTPHOTOS holder transfers it to the next-qualifying guest', () => {
  it('the next-qualifying guest holds MOSTPHOTOS after the holder is deleted via the route', async () => {
    const holder = makeGuest('AC1 Holder');
    const nextUp = makeGuest('AC1 Next Up');
    submitN(holder, 2);
    submitN(nextUp, 1);
    // Precondition: holder is the sole MOSTPHOTOS holder (matches the real
    // strict-most: 2 visible task submissions vs nextUp's 1).
    grantMostPhotosDirect(holder);
    expect(heldCodes(holder)).toContain('MOSTPHOTOS');
    expect(heldCodes(nextUp)).not.toContain('MOSTPHOTOS');

    const res = await adminAgent.post(`/admin/guests/${holder}/delete`).type('form').send({});
    expect(res.status).toBe(303);

    // Holder is gone (FK cascade removed their submissions too); nextUp now
    // has the strict-most (1 vs 0 among what remains) and must hold
    // MOSTPHOTOS without any unrelated event triggering the recompute.
    expect(db.prepare('SELECT id FROM guests WHERE id = ?').get(holder)).toBeUndefined();
    expect(heldCodes(nextUp)).toContain('MOSTPHOTOS');
  });
});

describe('AC2: deleting a badge-less guest behaves exactly as it does today', () => {
  it('succeeds with a 303 and writes/removes no guest_badges row for any other guest', async () => {
    // Wipe transferable-badge-relevant state left over from AC1 so this
    // scenario's "no other guest's row changed" check starts from a state
    // that is actually internally consistent (a real submission count behind
    // every held badge), not from AC1's now-stale nextUp grant.
    db.prepare('DELETE FROM submissions').run();
    db.prepare('DELETE FROM guest_badges').run();

    const bystander = makeGuest('AC2 Bystander');
    submitN(bystander, 5);
    // Bystander is the current, real MOSTPHOTOS holder (sole guest with any
    // visible task submissions) — its guest_badges row is the control group:
    // an unrelated delete must leave it untouched.
    grantMostPhotosDirect(bystander);
    expect(heldCodes(bystander)).toContain('MOSTPHOTOS');

    const noBadges = makeGuest('AC2 No Badges');
    // No submissions, no badges of any kind.
    expect(heldCodes(noBadges)).toEqual([]);

    const before = db
      .prepare(
        'SELECT guest_id, badge_id, awarded_by FROM guest_badges ORDER BY guest_id, badge_id'
      )
      .all();

    const res = await adminAgent.post(`/admin/guests/${noBadges}/delete`).type('form').send({});
    expect(res.status).toBe(303);

    expect(db.prepare('SELECT id FROM guests WHERE id = ?').get(noBadges)).toBeUndefined();

    // Bystander's real submission count (5) still strictly exceeds every
    // other guest's (0), so the route's recompute is a true no-op here: the
    // full guest_badges table is byte-for-byte unchanged.
    const after = db
      .prepare(
        'SELECT guest_id, badge_id, awarded_by FROM guest_badges ORDER BY guest_id, badge_id'
      )
      .all();
    expect(after).toEqual(before);
    expect(heldCodes(bystander)).toContain('MOSTPHOTOS');
  });
});
