// tests/badge-moment-priority.test.js
// Issue #714: derive the badge-celebration priority from the catalog,
// retiring src/routes/guest.js's hard-coded BADGE_MOMENT_PRIORITY list. Covers:
//   AC1 — GARDEN (auto, threshold 15) outranks COMPLETIONIST (metric,
//         threshold null) when both are newly earned on the same submit,
//         reproducing #255's shipped choice, via scoring.primaryNewBadge.
//   AC2 — a type='auto' threshold=20 badge outranks GARDEN (threshold 15):
//         resolution reads threshold, not a code list.
//   AC3 — scoring.compareBadgeMoment orders an unlisted type ('mystery')
//         last and a listed one ('special') first, with a finite result
//         (no NaN) — exercised on synthetic objects only, since a real
//         'mystery' row would violate the badges.type CHECK constraint.
//   AC4 — primaryNewBadge returns null for an empty newBadgeCodes array and
//         for a list naming only codes the guest does not hold. (AC4's
//         render half — no badge-dialog markup — is covered by
//         tests/rewards.test.js's AC1.)
//   AC5 — two badges tied on type AND threshold order by code ascending
//         (ALPHA before ZEBRA) — also on the comparator, because
//         primaryNewBadge's own input is already code-sorted by SQL and so
//         cannot distinguish a comparator that omits this key.
//
// REQUIRE ORDER: config / db / services are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH, matching tests/rewards.test.js.
'use strict';

const crypto = require('crypto');
const { loadApp } = require('./helpers/testApp');

let db;
let scoring;

beforeAll(() => {
  const loaded = loadApp();
  db = loaded.db;
  scoring = require('../src/services/scoring');
});

function insertGuest() {
  return db
    .prepare(`INSERT INTO guests (token, name, onboarded) VALUES (?, ?, 1)`)
    .run(`badge-priority-${crypto.randomUUID()}`, 'Badge Priority Guest').lastInsertRowid;
}

// Look up a seeded catalog badge's id by code (GARDEN/COMPLETIONIST/etc. are
// upserted by ensureBadgeCatalog() at db.js load time — see loadApp's
// require-order comment above).
function badgeIdByCode(code) {
  return db.prepare('SELECT id FROM badges WHERE code = ?').get(code).id;
}

// Grant an already-seeded catalog badge to a guest directly, bypassing
// recomputeBadges — the same "seed the end state, then exercise the function
// under test" shape tests/rewards.test.js's seedCompletedTasks helper uses.
function grantBadge(guestId, code) {
  db.prepare(
    `INSERT INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, 'system', 0)`
  ).run(guestId, badgeIdByCode(code));
}

// Insert a NEW catalog badge row (not one of the seeded eight) so AC2 can
// exercise "a higher-threshold auto badge wins" without mutating GARDEN's own
// seeded threshold. type='auto' is a value badges.type's CHECK constraint
// accepts, so this is a legal row — unlike AC3's synthetic 'mystery' objects.
function insertAutoBadge(code, threshold) {
  return db
    .prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES (?, ?, 'auto', ?, '/badges/test.svg', 'test badge')`
    )
    .run(code, code, threshold).lastInsertRowid;
}

// ---------------------------------------------------------------------------
// AC1
// ---------------------------------------------------------------------------
it('AC1: GARDEN (auto) outranks COMPLETIONIST (metric) when both are newly earned', () => {
  const guestId = insertGuest();
  grantBadge(guestId, 'GARDEN');
  grantBadge(guestId, 'COMPLETIONIST');

  const primary = scoring.primaryNewBadge(guestId, ['GARDEN', 'COMPLETIONIST']);
  expect(primary).not.toBeNull();
  expect(primary.code).toBe('GARDEN');
});

// ---------------------------------------------------------------------------
// AC2
// ---------------------------------------------------------------------------
it('AC2: a type=auto threshold=20 badge outranks GARDEN (threshold 15) — read from threshold, not code', () => {
  const guestId = insertGuest();
  grantBadge(guestId, 'GARDEN');
  insertAutoBadge('TESTHI20', 20);
  grantBadge(guestId, 'TESTHI20');

  const primary = scoring.primaryNewBadge(guestId, ['GARDEN', 'TESTHI20']);
  expect(primary).not.toBeNull();
  expect(primary.code).toBe('TESTHI20');
});

// Compare a pair and assert the comparator never answers NaN. A NaN result —
// from an unguarded rank or threshold lookup — reads as "not less than, not
// greater than" and would slip past a bare toBeLessThan/toBeGreaterThan pair
// silently, so finiteness is asserted here rather than at each call site.
function compareFinite(a, b) {
  const result = scoring.compareBadgeMoment(a, b);
  expect(Number.isNaN(result)).toBe(false);
  return result;
}

// ---------------------------------------------------------------------------
// AC3 (synthetic objects — 'mystery' is not a value badges.type's CHECK
// constraint permits, so this cannot be exercised through a real DB row)
// ---------------------------------------------------------------------------
it('AC3: compareBadgeMoment orders a listed type before an unlisted one, with a finite result', () => {
  const known = { type: 'special', threshold: null, code: 'A' };
  const unlisted = { type: 'mystery', threshold: null, code: 'B' };

  const result = compareFinite(known, unlisted);
  expect(result).toBeLessThan(0); // special sorts first
  expect(Number.isFinite(result)).toBe(true);

  const reversed = compareFinite(unlisted, known);
  expect(reversed).toBeGreaterThan(0); // mystery sorts last
  expect(Number.isFinite(reversed)).toBe(true);

  // Same finiteness contract on the OTHER sentinel: a real threshold compared
  // against a null one inside the same type rank. Returning the difference
  // rather than a sign here would hand back -Infinity.
  const withThreshold = { type: 'auto', threshold: 15, code: 'GARDEN' };
  const withoutThreshold = { type: 'auto', threshold: null, code: 'NULLTH' };
  expect(Number.isFinite(compareFinite(withThreshold, withoutThreshold))).toBe(true);
  expect(Number.isFinite(compareFinite(withoutThreshold, withThreshold))).toBe(true);
  expect(compareFinite(withThreshold, withoutThreshold)).toBeLessThan(0);
});

// ---------------------------------------------------------------------------
// AC4
// ---------------------------------------------------------------------------
it('AC4: primaryNewBadge returns null for an empty list, and for a list of codes the guest does not hold', () => {
  const guestId = insertGuest();

  expect(scoring.primaryNewBadge(guestId, [])).toBeNull();
  expect(scoring.primaryNewBadge(guestId, ['GARDEN'])).toBeNull(); // guest holds nothing yet

  grantBadge(guestId, 'GARDEN');
  // GARDEN is held, but not named in newBadgeCodes — still null.
  expect(scoring.primaryNewBadge(guestId, ['COMPLETIONIST'])).toBeNull();
});

// ---------------------------------------------------------------------------
// AC5
// ---------------------------------------------------------------------------
it('AC5: two badges tied on type and threshold order by code ascending (ALPHA before ZEBRA)', () => {
  const zebra = { type: 'auto', threshold: 10, code: 'ZEBRA' };
  const alpha = { type: 'auto', threshold: 10, code: 'ALPHA' };

  // Asserted on the comparator, NOT through primaryNewBadge: that path filters
  // getGuestBadges's rows, which SQL already returns in `code ASC` order within
  // a type/threshold tie, so a comparator missing this third key would still
  // resolve ALPHA there and the test would pass while proving nothing. Comparing
  // the pair in BOTH directions is what actually pins the code tiebreak.
  expect(compareFinite(zebra, alpha)).toBeGreaterThan(0);
  expect(compareFinite(alpha, zebra)).toBeLessThan(0);
});
