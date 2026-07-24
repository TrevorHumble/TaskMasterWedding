// src/services/badges.js
//
// The metrics-driven badge rule registry (issue #80).
//
// This module holds exactly the ENGINE-COMPUTED badges — the ones whose
// holder set is derived from live data rather than hand-awarded by the
// admin. It does NOT include the 'auto' threshold badges (BLOOM/BOUQUET/
// GARDEN); those keep their own threshold logic in scoring.js unchanged.
//
// Two registry shapes, one per badge kind (see the issue's implementation
// plan step 2):
//   - METRIC_BADGES: code -> (guestId) => boolean. A one-time badge a single
//     guest either currently qualifies for or doesn't. scoring.js's
//     recomputeBadges(guestId) grants/revokes per-guest from this.
//   - TRANSFERABLE_BADGES: code -> () => Set<guestId>. A "steal-able" badge
//     computed globally; scoring.js's recomputeTransferableBadges() replaces
//     the whole holder set from this every time it runs.
//
// Both close over the module-level `db` singleton required below, the same
// way scoring.js and the other services bind their `db` — so a registry
// function's signature carries only the inputs that vary per call.
//
// Each function is backed by exactly one prepared statement over
// submissions/tasks, restricted to VISIBLE rows (taken_down = 0), matching
// the canonical visibility rule used everywhere else in scoring.
//
// Badge identity is the existing `badges.code` column (NOT NULL UNIQUE) —
// there is no second identity column here. Adding a badge to either map
// below is what "adds" it to the engine; scripts/seed.js must also seed its
// catalog row (type = 'metric' or 'transferable').
//
// TOPLIKED (issue #817) is the current TRANSFERABLE_BADGES member: its
// holder set is every guest owning a rank === 1 placing in
// scoring.crowdFavorites() (see that registry entry below for the full
// rationale, including why it requires scoring.js lazily).

'use strict';

const { db } = require('../db');
// tasks.js is the ONE active-task owner (issue #727) — liveTaskWhere('t')
// consumes it here instead of a hand-written 'hidden'/is_active predicate.
const tasks = require('./tasks');
// scoring.js is NOT required at this file's top level — see TOPLIKED's
// compute function below for why.

// ---------------------------------------------------------------------------
// COMPLETIONIST (metric, one-time): the guest has a visible submission for
// EVERY currently-live task that is not a one-day-only challenge. Computed
// as "count of live, non-challenge tasks this guest has NOT visibly
// completed" == 0, so an event with zero such tasks would vacuously qualify
// everyone — acceptable here because the admin always seeds at least one
// ordinary task before guests can play.
//
// `tasks.challengeTaskWhere('t')` (issue #753; tasks.js is the declared
// owner of this predicate, not a hand-written `special_date IS NULL` here)
// permanently excludes every one-day-only challenge from this "every active
// task" set — owner decision D2 (#624): a challenge appearing mid-event must
// never strip Completionist from a guest who already earned it, and a
// challenge a guest hasn't reached yet must never block them from earning
// it. special_date, not special_mode = 'oneday', is what this filters on,
// matching the single authoritative fact every other #753 read (the seal
// predicate, the on-day bonus) also keys on.
// ---------------------------------------------------------------------------
const stmtMissingActiveTaskCount = db.prepare(`
  SELECT COUNT(*) AS n
    FROM tasks t
   WHERE ${tasks.liveTaskWhere('t')}
     AND NOT ${tasks.challengeTaskWhere('t')}
     AND NOT EXISTS (
       SELECT 1 FROM submissions s
        WHERE s.task_id = t.id
          AND s.guest_id = ?
          AND s.taken_down = 0
     )
`);

/**
 * @param {number} guestId
 * @returns {boolean} true if the guest currently covers every active task.
 */
function isCompletionist(guestId) {
  return stmtMissingActiveTaskCount.get(guestId).n === 0;
}

// ---------------------------------------------------------------------------
// Registries.
// ---------------------------------------------------------------------------

/** code -> (guestId) => boolean */
const METRIC_BADGES = {
  COMPLETIONIST: isCompletionist,
};

// ---------------------------------------------------------------------------
// TOPLIKED (transferable, issue #817): holder set is every guest who owns a
// rank === 1 placing in scoring.crowdFavorites() — the crowd's single
// most-liked photo (or every tied co-leader, standard-competition ranking).
// A distinct concept from the retired #711 MOSTLIKED/MOSTPHOTOS pair (that
// pair counted a guest's LIFETIME total likes/photos; this counts who
// currently OWNS the single #1 spot) and additive to, not a replacement for,
// #788's render-time crown marker on the photo tile itself — that marker
// stays a pure read of crowdFavorites() with no guest_badges row; this badge
// materializes the same rank-1 fact as a holder set recomputeTransferableBadges()
// can grant/revoke.
//
// scoring.js requires this module ('./badges') at ITS OWN top level (to
// destructure METRIC_BADGES/TRANSFERABLE_BADGES), so a top-level
// require('./scoring') HERE would complete a load-order-sensitive
// cycle — mirroring notifications.js's own documented reason for deferring
// its require('./scoring') to call time (see that file's KIND_VIEW.
// crowd_favorite.parts()). Deferring the require to inside this function
// sidesteps the cycle: by the time recomputeTransferableBadges() ever calls
// this function, both modules have long since finished loading.
// ---------------------------------------------------------------------------

/**
 * @returns {Set<number>} guestIds owning a rank === 1 crowdFavorites() placing.
 */
function topLikedHolders() {
  const scoring = require('./scoring');
  const holders = new Set();
  for (const placing of scoring.crowdFavorites()) {
    if (placing.rank === 1) {
      holders.add(placing.guest_id);
    }
  }
  return holders;
}

/** code -> () => Set<guestId> */
const TRANSFERABLE_BADGES = {
  TOPLIKED: topLikedHolders,
};

module.exports = {
  METRIC_BADGES,
  TRANSFERABLE_BADGES,
};
