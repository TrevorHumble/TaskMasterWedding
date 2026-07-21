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

'use strict';

const { db } = require('../db');
// tasks.js is the ONE active-task owner (issue #727) — liveTaskWhere('t')
// consumes it here instead of a hand-written 'hidden'/is_active predicate.
const tasks = require('./tasks');

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

// No transferable badges are currently registered (MOSTPHOTOS/MOSTLIKED
// retired by issue #711). recomputeTransferableBadges() in scoring.js still
// iterates any badges.type = 'transferable' catalog rows and safely no-ops
// on a row with no registry entry (`if (!computeHolders) continue`), so the
// engine stays in place for a future transferable badge.
/** code -> () => Set<guestId> */
const TRANSFERABLE_BADGES = {};

module.exports = {
  METRIC_BADGES,
  TRANSFERABLE_BADGES,
};
