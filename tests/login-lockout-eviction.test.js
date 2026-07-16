// tests/login-lockout-eviction.test.js
// Issue #283 (absorbing #464): bounding the guest-login lockout Map in
// src/routes/auth.js so an unauthenticated flood of distinct made-up
// contacts cannot grow it without bound.
//
// AC7: stale entries (lockout not active, last failure older than the
//      lockout window) are swept the next time a NEW contact fails.
// AC8: a hard cap (config.GUEST_LOGIN_TRACKED_MAX) bounds the tracked-contact
//      count under a flood of distinct contacts, and a locked contact is not
//      evicted early to make room while any unlocked entry could go instead.
//      Driven at TWO flood shapes, because they exercise different eviction
//      paths and only the second one can catch an unbounded insert:
//        - unlocked flood: every flood contact stays under the lockout
//          threshold, so an unlocked victim always exists -> the locked
//          contact under test survives (AC8's second half).
//        - fully-locked flood: every flood contact reaches
//          GUEST_LOGIN_MAX_ATTEMPTS, so NO unlocked victim exists -> the cap
//          can only hold if eviction falls back to the soonest-expiring
//          locked entry (AC8's first half). This is the shape that fails
//          against an unconditional insert.
//
// Both ACs drive the SAME internal logic POST /login calls, via the
// test-only seam `router._recordGuestLoginFailureForTest(contact, now)` /
// `router._guestLockoutTrackedCount()` (src/routes/auth.js) — an injectable
// clock, not real sleeps, per the issue's own "with an injectable clock"
// wording.
//
// REQUIRE ORDER: env overrides set BEFORE loadApp() so config picks them up
// on first require (same rule as tests/login-lockout-engages.test.js).
'use strict';

// GUEST_LOGIN_MAX_ATTEMPTS is deliberately the SHIPPED default (5), not a
// raised value: a threshold high enough that a flood contact never locks out
// would mean an unlocked eviction victim always exists, which is exactly the
// one configuration in which an unbounded insert stays invisible. AC7's 3
// attempts per contact still sit under 5, so its entries stay unlocked as
// that test requires. The lockout window is short enough to step past with an
// injected timestamp rather than a real sleep.
process.env.GUEST_LOGIN_MAX_ATTEMPTS = '5';
process.env.GUEST_LOGIN_LOCKOUT_MS = '1000';
process.env.GUEST_LOGIN_TRACKED_MAX = '5';

const { loadApp } = require('./helpers/testApp');

const MAX_ATTEMPTS = 5;
const TRACKED_MAX = 5;
const LOCKOUT_MS = 1000;

let authRouter;

beforeAll(() => {
  loadApp();
  authRouter = require('../src/routes/auth');
});

/** Drive one contact all the way to an engaged lockout at instant `now`. */
function lockOut(contact, now) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    authRouter._recordGuestLoginFailureForTest(contact, now);
  }
}

describe('#283 AC7: stale entries are swept on the next new-contact failure', () => {
  it('3 failed attempts each for 3 distinct contacts, once stale, are swept to make room for a 4th', () => {
    const base = 1_000_000;

    // 3 distinct contacts, 3 failed attempts each — under
    // GUEST_LOGIN_MAX_ATTEMPTS=5, so none of these engage a lockout; each
    // entry is just "tracked with fails=3, lockedUntil=0".
    for (const contact of ['ac7-a@example.com', 'ac7-b@example.com', 'ac7-c@example.com']) {
      for (let i = 0; i < 3; i++) {
        authRouter._recordGuestLoginFailureForTest(contact, base);
      }
    }
    expect(authRouter._guestLockoutTrackedCount()).toBe(3);

    // Advance the clock past GUEST_LOGIN_LOCKOUT_MS (1000ms) — every existing
    // entry is now stale (not locked, and its last failure predates the
    // window). One more failed attempt for a 4th, NEW contact triggers the
    // sweep on insert.
    const afterWindow = base + LOCKOUT_MS + 1;
    authRouter._recordGuestLoginFailureForTest('ac7-d@example.com', afterWindow);

    // The stale 3 were swept; only the 4th (just-inserted) contact remains.
    expect(authRouter._guestLockoutTrackedCount()).toBe(1);
  });
});

describe('#283 AC8: bounded under a distinct-contact flood', () => {
  it('unlocked flood: the cap holds and the locked contact under test is never evicted (an unlocked victim always exists)', () => {
    const now = 5_000_000; // one instant: nothing is stale within this test

    // Lock ONE contact fully, so it carries an active lockedUntil.
    lockOut('ac8-locked@example.com', now);

    // Flood with 2 x GUEST_LOGIN_TRACKED_MAX distinct fresh contacts, ONE
    // failed attempt each — every flood entry stays unlocked, so eviction
    // always has an unlocked victim to take and must never touch the locked
    // contact.
    for (let i = 0; i < TRACKED_MAX * 2; i++) {
      authRouter._recordGuestLoginFailureForTest(`ac8-flood-${i}@example.com`, now + i);
    }

    expect(authRouter._guestLockoutTrackedCount()).toBeLessThanOrEqual(TRACKED_MAX);

    // The locked contact's own lockout still holds — never evicted early.
    // Assert its exact entry: still present, still carrying a lockedUntil in
    // the future, proving the flood did not remove and later re-create it as
    // a fresh, unlocked entry.
    const lockedEntry = authRouter._guestLockoutEntryForTest('ac8-locked@example.com');
    expect(lockedEntry).toBeDefined();
    expect(lockedEntry.lockedUntil).toBeGreaterThan(now);
  });

  it('fully-locked flood: the cap still holds when EVERY tracked contact is locked and no unlocked victim exists', () => {
    // A fresh time base far past the previous test's lockout window, so its
    // leftovers are stale and sweep away — this test starts from a clean map.
    const base = 6_000_000;

    // 2 x GUEST_LOGIN_TRACKED_MAX distinct contacts, each driven to a FULL
    // lockout. Staggered 10ms apart so their lockedUntil values are ordered
    // and distinct (the eviction fallback picks the soonest-expiring).
    for (let i = 0; i < TRACKED_MAX * 2; i++) {
      lockOut(`ac8-alllocked-${i}@example.com`, base + i * 10);
    }

    // The bound must hold with no unlocked entry anywhere to evict.
    expect(authRouter._guestLockoutTrackedCount()).toBeLessThanOrEqual(TRACKED_MAX);

    // Eviction took the soonest-expiring lockout, not an arbitrary one: the
    // LAST contact locked (the furthest-from-expiry, freshest lockout) is
    // still tracked and still locked.
    const freshest = authRouter._guestLockoutEntryForTest(
      `ac8-alllocked-${TRACKED_MAX * 2 - 1}@example.com`
    );
    expect(freshest).toBeDefined();
    expect(freshest.lockedUntil).toBeGreaterThan(base + (TRACKED_MAX * 2 - 1) * 10);
  });
});
