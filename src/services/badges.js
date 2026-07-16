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

// ---------------------------------------------------------------------------
// COMPLETIONIST (metric, one-time): the guest has a visible submission for
// EVERY currently-active task. Computed as "count of active tasks this guest
// has NOT visibly completed" == 0, so an event with zero active tasks would
// vacuously qualify everyone — acceptable here because the admin always
// seeds at least one task before guests can play.
// ---------------------------------------------------------------------------
const stmtMissingActiveTaskCount = db.prepare(`
  SELECT COUNT(*) AS n
    FROM tasks t
   WHERE t.is_active = 1
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
// MOSTPHOTOS (transferable): the guest(s) with the strict-most visible TASK
// submissions. Ties are ALL held simultaneously (AC2). The SQL below counts
// only visible, task-linked rows (task_id IS NOT NULL) and groups per guest —
// issue #247 excludes memory rows (task_id IS NULL) from this count, so a
// guest cannot steal the badge by uploading many memories instead of
// completing tasks. The "a guest with zero visible submissions never holds
// it" rule is enforced in JS by the `if (max === 0) return new Set()` guard
// below — without it, a fresh DB (max count 0) would make every guest a
// co-"winner".
// ---------------------------------------------------------------------------
const stmtVisibleCountsByGuest = db.prepare(`
  SELECT guest_id, COUNT(*) AS n
    FROM submissions
   WHERE taken_down = 0
     AND task_id IS NOT NULL
   GROUP BY guest_id
`);

/**
 * @returns {Set<number>} guest ids tied for the most visible submissions.
 */
function mostPhotosHolders() {
  const rows = stmtVisibleCountsByGuest.all();
  let max = 0;
  for (const row of rows) {
    if (row.n > max) max = row.n;
  }
  if (max === 0) return new Set();
  return new Set(rows.filter((row) => row.n === max).map((row) => row.guest_id));
}

// ---------------------------------------------------------------------------
// MOSTLIKED (transferable): the guest(s) whose VISIBLE submissions have
// collected the strict-most total likes, summed across every one of that
// guest's visible photos (issue #484) — a per-guest total, parallel to
// MOSTPHOTOS being a per-guest count of submissions rather than one photo's
// count. Ties are ALL held simultaneously, same as MOSTPHOTOS. The join below
// walks likes -> submissions and keeps only likes on a visible submission
// (taken_down = 0), so a taken-down photo's likes drop out of its guest's
// total; the "zero total likes never holds it" rule is the same
// `if (max === 0) return new Set()` guard as mostPhotosHolders — without it a
// fresh DB (max 0) would make every liked-nothing guest a co-"winner".
// ---------------------------------------------------------------------------
const stmtLikeTotalsByGuest = db.prepare(`
  SELECT s.guest_id AS guest_id, COUNT(*) AS n
    FROM likes l
    JOIN submissions s ON s.id = l.submission_id
   WHERE s.taken_down = 0
   GROUP BY s.guest_id
`);

/**
 * @returns {Set<number>} guest ids tied for the most total likes on their
 *   visible submissions.
 */
function mostLikedHolders() {
  const rows = stmtLikeTotalsByGuest.all();
  let max = 0;
  for (const row of rows) {
    if (row.n > max) max = row.n;
  }
  if (max === 0) return new Set();
  return new Set(rows.filter((row) => row.n === max).map((row) => row.guest_id));
}

// ---------------------------------------------------------------------------
// Registries.
// ---------------------------------------------------------------------------

/** code -> (guestId) => boolean */
const METRIC_BADGES = {
  COMPLETIONIST: isCompletionist,
};

/** code -> () => Set<guestId> */
const TRANSFERABLE_BADGES = {
  MOSTPHOTOS: mostPhotosHolders,
  MOSTLIKED: mostLikedHolders,
};

module.exports = {
  METRIC_BADGES,
  TRANSFERABLE_BADGES,
};
