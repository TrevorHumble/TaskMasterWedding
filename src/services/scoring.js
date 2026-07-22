// src/services/scoring.js
//
// Scoring engine and badge logic for Wedding Master.
//
// Responsibilities:
//   - getPoints / getCompletedCount: how many points a guest has.
//   - recomputeBadges: grant/revoke a guest's auto (BLOOM/BOUQUET/GARDEN) and
//     metric (COMPLETIONIST) badges from their current data. Idempotent.
//   - recomputeTransferableBadges: reassign any registered global transferable
//     badges to their current holder set (registry currently empty, #711).
//   - recomputeAfterSubmissionChange: the seam mutators call — runs the two
//     above in the correct order so no caller has to.
//   - awardSpecialBadge / removeSpecialBadge: admin-only hand-awarded badges.
//   - addBonusPoints: admin adjusts a guest's bonus point total (clamped at 0).
//   - leaderboard: every guest ordered by total points, with their badge codes.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

// src/db.js exports { db, ... }. Destructure the handle — do NOT write
// `const db = require('../db')` or `db.prepare` is undefined and this file
// crashes at load time on the first prepared statement below.
//
// AUTO_METRIC_BADGE_POINTS (issue #709) is owned by db.js, not here: db.js's
// own one-time backfill needs the same value and db.js cannot import this
// file back (require-cycle — db.js is the lower module, this file already
// imports it), so db.js is the single owner and this file just reads it.
const { db, AUTO_METRIC_BADGE_POINTS, getEventConfig } = require('../db');
const { METRIC_BADGES, TRANSFERABLE_BADGES } = require('./badges');
// TASK_BADGE_CODE_PREFIX is defined once in task-badges.js (the single owner
// of the 'TASK-' literal — see that module's doc comment); createCustomBadge
// below imports it rather than hard-coding a second copy that could drift.
const { TASK_BADGE_CODE_PREFIX } = require('./task-badges');
// VISIBLE_WHERE ('s.taken_down = 0') is owned by feed.js; badgeWithHolders'
// query below consumes it rather than re-deriving the visibility literal (#488).
// feed.js requires only '../db', so this import introduces no cycle.
const { VISIBLE_WHERE } = require('./feed');
// parseSqliteDatetime (issue #656) is the ONE place a SQLite `datetime('now')`
// string becomes a UTC Date — reused here rather than re-deriving the space
// -> 'T' / append-'Z' rule.
const { parseSqliteDatetime } = require('./relative-time');
// eventLocalDateString (issue #656) is the ONE place a UTC instant becomes an
// event-local YYYY-MM-DD. event-days.js is dependency-free (no `db` require),
// so this import introduces no cycle.
const eventDays = require('./event-days');

// ---------------------------------------------------------------------------
// Canonical auto-badge thresholds. These MUST match the seeded `badges` rows
// (section 02 seed.js): BLOOM=5, BOUQUET=10, GARDEN=15 completed tasks.
//
// Two shapes are exported on purpose:
//   - BADGE_THRESHOLDS: array of { code, n } objects, used internally by
//     recomputeBadges to map a code to its threshold number.
//   - AUTO_THRESHOLDS:  plain array of numbers [5, 10, 15], used by section 04
//     for numeric comparisons and progress-bar math. It is derived from
//     BADGE_THRESHOLDS so the two can never drift apart.
// These are the single source of truth for the threshold numbers used in UI
// copy and tests.
// ---------------------------------------------------------------------------
const BADGE_THRESHOLDS = [
  { code: 'BLOOM', n: 5 },
  { code: 'BOUQUET', n: 10 },
  { code: 'GARDEN', n: 15 },
];

// Plain numeric thresholds, e.g. [5, 10, 15]. Section 04 imports THIS one for
// `completedTasks < AUTO_THRESHOLDS[i]` style comparisons and progress math.
const AUTO_THRESHOLDS = BADGE_THRESHOLDS.map((b) => b.n);

/**
 * Points a single photo is worth. The /feed per-photo display, the
 * end-of-night slideshow, and the guest success card (issue #756) all call
 * this so the base+bonus combination lives only here, never re-typed as a
 * second arithmetic rule at any call site.
 *
 * A TASK photo earns its task's worth (1-3, src/services/tasks.js's
 * MIN_WORTH..MAX_WORTH) plus its admin bonus (photoBonus) plus its BANKED
 * one-day-only challenge bonus (bonusAmount, submissions.bonus_amount, issue
 * #753) — the same three terms getPoints()/leaderboard() sum in aggregate
 * (issue #756 closed the gap between this function and that aggregate rule).
 * A MEMORY (issue #247, task_id IS NULL) earns NO automatic per-photo base —
 * only its admin bonus — matching the aggregate rule, which excludes a
 * memory's base while still counting its photo_bonus. Since issue #656 the
 * aggregate rule ALSO includes a memory-DAY term (+1 for the guest's first
 * visible memory each event-local day, derived in getPoints/leaderboard, not
 * here) — this per-photo function has no notion of "day" or "first", so it
 * still returns 0 for an un-bonused memory; the day bonus is a separate,
 * once-per-day addition the aggregate makes on top of whatever this function
 * returns for each individual photo. bonusAmount is always 0 for a memory
 * too, since nothing ever banks a one-day-only bonus on one. `worth` and
 * `bonusAmount` both default to 0 (issues #727, #756): a one-arg call yields
 * just `photoBonus`, never NaN, and a memory caller passes worth=0 explicitly
 * for the same reason a task caller passes its task's real worth (>= 1).
 *
 * @param {number} photoBonus - the photo's submissions.photo_bonus value
 * @param {number} [worth=0] - the task's worth (1-3), or 0 for a memory
 * @param {number} [bonusAmount=0] - the photo's BANKED one-day-only bonus
 *   (submissions.bonus_amount, issue #753); 0 for an ordinary submission and
 *   for one banked on an off-day
 * @returns {number}
 */
function photoPoints(photoBonus, worth = 0, bonusAmount = 0) {
  return worth + photoBonus + bonusAmount;
}

// ---------------------------------------------------------------------------
// Prepared statements (compiled once, reused on every call for speed).
// ---------------------------------------------------------------------------

// Count a guest's completed tasks = visible, task-linked submissions
// (taken_down = 0 AND task_id IS NOT NULL). UNIQUE(guest_id, task_id)
// guarantees at most one row per task, so among task-linked rows this is both
// "submissions that count" and "distinct tasks completed" — but since #247
// made task_id nullable, "visible submission" and "task completion" are no
// longer the same set: a memory (task_id IS NULL) is a visible submission
// that completes no task and must NOT add a base point, so the
// task_id IS NOT NULL filter below is load-bearing, not decorative.
//
// CANONICAL completed-count rule (see section 1a, Decision A): we count
// visible TASK submissions regardless of whether the task is still live.
// There is intentionally NO join to `tasks` and NO liveness filter here, so
// a guest keeps points/badges even if the admin later hides a task. The
// guest home page must use this same rule for its "X of N complete" numerator.
const stmtCompletedCount = db.prepare(
  'SELECT COUNT(*) AS c FROM submissions WHERE guest_id = ? AND taken_down = 0 AND task_id IS NOT NULL'
);

// Read a guest's admin-set bonus points plus avatar_path in the same row
// read, so getPoints can derive the starter-photo term (issue #716) via
// starterTaskContribution without a second guests query.
const stmtBonusPoints = db.prepare('SELECT bonus_points, avatar_path FROM guests WHERE id = ?');

// Sum a guest's per-photo bonus (submissions.photo_bonus, issue #89) over
// their VISIBLE submissions only — same taken_down = 0 guard as
// stmtCompletedCount, so a taken-down photo's bonus never counts (AC6).
// COALESCE(..., 0) covers the guest-has-no-submissions case, where SUM would
// otherwise return SQL NULL.
const stmtPhotoBonusSum = db.prepare(
  'SELECT COALESCE(SUM(photo_bonus), 0) AS pb FROM submissions WHERE guest_id = ? AND taken_down = 0'
);

// Sum a guest's task WORTH (issue #727) over their VISIBLE, task-linked
// submissions — the worth-aware replacement for the old flat
// "completed * POINTS_PER_PHOTO" base. JOIN (not LEFT JOIN) tasks naturally
// drops memories (task_id IS NULL has no tasks row to join), same set
// stmtCompletedCount counts. NO liveness filter — matching the canonical
// completed-count rule above, a guest keeps a task's worth even after the
// admin later hides it. COALESCE(..., 0) covers the no-submissions case.
const stmtWorthSum = db.prepare(
  `SELECT COALESCE(SUM(t.worth), 0) AS w
     FROM submissions s
     JOIN tasks t ON t.id = s.task_id
    WHERE s.guest_id = ? AND s.taken_down = 0`
);

// Sum a guest's BANKED one-day-only bonus (submissions.bonus_amount, issue
// #753) over their VISIBLE submissions only — same taken_down = 0 guard as
// stmtWorthSum/stmtPhotoBonusSum above, so a taken-down photo's banked bonus
// never counts and a restore brings it back, both halves (worth AND bonus)
// moving together with no separate scoring term for takedown/restore.
// bonus_amount is banked AT SUBMIT TIME (never derived here from
// task.special_date/special_bonus — see submissions.js's submitPhoto doc
// comment for why a derived read would silently lose the bonus on a later
// replace), so this is a plain SUM, not a join against tasks.
// COALESCE(..., 0) covers the no-submissions case.
const stmtBonusAmountSum = db.prepare(
  `SELECT COALESCE(SUM(bonus_amount), 0) AS ba FROM submissions WHERE guest_id = ? AND taken_down = 0`
);

// Every visible MEMORY's created_at for one guest (issue #656): task_id IS
// NULL AND taken_down = 0, the same "visible memory" set the memory-day bonus
// is derived from. Read as raw strings — the JS conversion to an event-local
// calendar day happens in memoryDayCount below, via parseSqliteDatetime +
// eventDays.eventLocalDateString, never in SQL (SQLite has no IANA timezone
// support, so a fixed-offset `datetime()` shift would be wrong across a DST
// transition).
const stmtGuestMemoryCreatedAts = db.prepare(
  'SELECT created_at FROM submissions WHERE guest_id = ? AND task_id IS NULL AND taken_down = 0'
);

// Every visible MEMORY's (guest_id, created_at) across ALL guests (issue
// #656), read in ONE query so leaderboard() can fold every guest's
// memory-day count in a single pass rather than issuing a per-guest query
// inside its loop (the stale-count defect class this issue calls out by name).
const stmtAllVisibleMemoryCreatedAts = db.prepare(
  'SELECT guest_id, created_at FROM submissions WHERE task_id IS NULL AND taken_down = 0'
);

/**
 * The DISTINCT event-local days on which `guestId` has at least one visible
 * memory (issue #656), as a `Set` of `YYYY-MM-DD` strings — the memory-day
 * bonus term, worth +1 per day it counts. This is the single owner of "what
 * counts as a visible memory, and which event-local day it lands on": every
 * caller that needs the day COUNT (memoryDayCount, below) or the day
 * MEMBERSHIP test (a route deciding whether TODAY specifically has already
 * been claimed) reads this one function rather than re-deriving the
 * `task_id IS NULL AND taken_down = 0` predicate or the parseSqliteDatetime
 * -> eventLocalDateString fold a second time (see GET /tasks in
 * src/routes/guest.js, which calls `.has(todayIso)` on the returned Set
 * instead of running its own query).
 * Derived, not banked: a memory row's `created_at` never changes
 * (submissions.js never replaces a memory row), so this is safe to
 * recompute on every read, and a takedown/restore of a day's only memory
 * automatically drops/re-adds that day's point with no separate bookkeeping.
 * Day boundary is the EVENT-local date in `timezone` (via
 * eventDays.eventLocalDateString), never server UTC.
 * @param {number} guestId
 * @param {string} timezone - an IANA zone name (db.getEventConfig().timezone).
 * @returns {Set<string>} event-local YYYY-MM-DD day strings
 */
function memoryDaysFor(guestId, timezone) {
  const rows = stmtGuestMemoryCreatedAts.all(guestId);
  const days = new Set();
  for (const row of rows) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    days.add(eventDays.eventLocalDateString(timezone, instant));
  }
  return days;
}

/**
 * The count of DISTINCT event-local days on which `guestId` has at least one
 * visible memory (issue #656) — a thin wrapper over memoryDaysFor for callers
 * that only need the count (getPoints, below), not the day set itself.
 * @param {number} guestId
 * @param {string} timezone - an IANA zone name (db.getEventConfig().timezone).
 * @returns {number}
 */
function memoryDayCount(guestId, timezone) {
  return memoryDaysFor(guestId, timezone).size;
}

/**
 * The all-guests generalization memoryDayCount needs for leaderboard(): every
 * guest's memory-day count, computed from ONE query (stmtAllVisibleMemoryCreatedAts)
 * rather than one query per guest, folded into a Map so leaderboard's per-row
 * loop is a plain lookup.
 * @param {string} timezone
 * @returns {Map<number, number>} guestId -> distinct event-local memory-day count
 */
function memoryDayCountsByGuest(timezone) {
  const daysByGuest = new Map();
  for (const row of stmtAllVisibleMemoryCreatedAts.all()) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    const dayIso = eventDays.eventLocalDateString(timezone, instant);
    let days = daysByGuest.get(row.guest_id);
    if (!days) {
      days = new Set();
      daysByGuest.set(row.guest_id, days);
    }
    days.add(dayIso);
  }
  const counts = new Map();
  for (const [guestId, days] of daysByGuest) {
    counts.set(guestId, days.size);
  }
  return counts;
}

// Sum a guest's badge AWARD points (guest_badges.points) over awards whose
// earning photo is currently VISIBLE. Every row written by stmtGrantBadge
// (system/admin grants: auto, metric, transferable, special) carries
// submission_id IS NULL, so the LEFT JOIN's ON clause passes those rows
// through unconditionally regardless of points — an auto/metric grant
// contributes AUTO_METRIC_BADGE_POINTS (issue #709, while held) and a
// transferable/special grant contributes 0, but either way there is no
// submission to gate on. A task-badge award's row (written by
// task-badges.awardTaskBadge, issue #483; never by stmtGrantBadge) DOES
// carry a submission_id and is counted ONLY while that submission is
// taken_down = 0 — the same visibility guard stmtPhotoBonusSum applies to
// photo_bonus, mirrored here so a taken-down earning photo drops its award
// points from the score exactly like a taken-down photo drops its bonus
// (AC6), and a restore re-adds them. COALESCE(..., 0) covers the
// no-awards case, where SUM would otherwise return SQL NULL.
const stmtAwardPointsSum = db.prepare(
  `SELECT COALESCE(SUM(gb.points), 0) AS ap
     FROM guest_badges gb
     LEFT JOIN submissions s ON s.id = gb.submission_id
    WHERE gb.guest_id = ?
      AND (gb.submission_id IS NULL OR ${VISIBLE_WHERE})`
);

// Look up a badge row by its code (e.g. 'BLOOM', 'EARLYBIRD').
const stmtBadgeByCode = db.prepare('SELECT * FROM badges WHERE code = ?');

// Does this guest already hold this badge? (returns the guest_badges row or undefined)
const stmtGuestBadge = db.prepare('SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?');

// Grant a badge to a guest. UNIQUE(guest_id, badge_id) prevents duplicates;
// "INSERT OR IGNORE" makes a repeat grant a harmless no-op (a repeat call
// with a different `points` value does NOT update the existing row — the
// grant call sites below only ever call this when the guest does not yet
// hold the badge, so that never matters in practice).
//
// `points` (issue #709) is the ONE place a grant decides whether holding
// this badge is worth anything: the two recomputeBadges branches below pass
// AUTO_METRIC_BADGE_POINTS for an auto/metric grant, while
// recomputeTransferableBadges and awardSpecialBadge pass 0 — a transferable
// or admin-special badge stays a display-only award. Whatever is written
// here is exactly what stmtAwardPointsSum/leaderboard later sum on read; no
// other statement in this file writes guest_badges.points for a system/
// admin grant.
const stmtGrantBadge = db.prepare(
  'INSERT OR IGNORE INTO guest_badges (guest_id, badge_id, awarded_by, points) VALUES (?, ?, ?, ?)'
);

// Remove a specific badge from a guest.
const stmtRevokeBadge = db.prepare('DELETE FROM guest_badges WHERE guest_id = ? AND badge_id = ?');

// All badges of a given type (used by recomputeTransferableBadges to walk
// every 'transferable' catalog row without hard-coding a code list here).
const stmtBadgesByType = db.prepare('SELECT * FROM badges WHERE type = ?');

// Every 'system'-awarded holder of one badge (used by recomputeTransferableBadges
// to diff the current holder set against the freshly computed one).
const stmtSystemHoldersOfBadge = db.prepare(
  "SELECT guest_id FROM guest_badges WHERE badge_id = ? AND awarded_by = 'system'"
);

// Every guest id, used by recomputeAfterTaskChange to re-run the per-guest
// pass for the whole event (issue #701). An empty guests table yields an
// empty array, so the for-of loop below is a no-op — no guest, no crash.
const stmtAllGuestIds = db.prepare('SELECT id FROM guests');

// Adjust a guest's bonus points by a delta (can be negative), clamped at 0.
// MAX(0, ...) enforces the floor (see section 1a, Decision B): a deduction can
// never drive bonus_points below zero. Section 08's admin acceptance check
// depends on this floor.
const stmtAddBonus = db.prepare(
  'UPDATE guests SET bonus_points = MAX(0, bonus_points + ?) WHERE id = ?'
);

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Number of tasks this guest has completed (visible, task-linked submissions
 * only — memories excluded, issue #247).
 * Uses the canonical rule: taken_down = 0 AND task_id IS NOT NULL, ignoring
 * task active state.
 * @param {number} guestId
 * @returns {number}
 */
function getCompletedCount(guestId) {
  const row = stmtCompletedCount.get(guestId);
  return row ? row.c : 0;
}

/**
 * Total points for a guest = SUM of completed tasks' worth (issue #727;
 * memories earn no base, issue #247)
 *   + per-photo bonus (SUM of submissions.photo_bonus over ALL visible
 *     submissions, task or memory — issue #89, preserved by #247)
 *   + the BANKED one-day-only bonus (SUM of submissions.bonus_amount over
 *     ALL visible submissions — issue #753; banked at submit time on the
 *     task's special_date, 0 for every ordinary submission)
 *   + admin guests.bonus_points
 *   + the DERIVED profile-photo starter term (issue #716; supersedes #409's
 *     one-time banked award): +STARTER_PHOTO_POINT while guests.avatar_path
 *     is set, 0 while it is not — read through starterTaskContribution, the
 *     single owner of the `!!avatar_path` rule, so this never re-derives it.
 *   + the DERIVED memory-day term (issue #656): +1 for each DISTINCT
 *     event-local day on which the guest has >= 1 visible memory
 *     (memoryDayCount, above) — capped at one point per day by construction
 *     (a Set of day strings, not a count of memories), NOT banked (a
 *     memory's created_at is stable — submissions.js never replaces a memory
 *     row — so this is safe to recompute on every read; a takedown/restore
 *     of a day's only memory moves this term automatically, no separate
 *     bookkeeping).
 *   + badge AWARD points (SUM of guest_badges.points), counted only while
 *     the award's earning photo is visible where one exists (AC6). This
 *     term now covers three shapes: a task-badge judgment amount (issue
 *     #483), AUTO_METRIC_BADGE_POINTS for each auto/metric badge the guest
 *     currently holds (issue #709 — the point derives on read from holding
 *     the badge row, and leaves automatically when recomputeBadges revokes
 *     it), and 0 for a transferable/admin-special grant.
 * bonus_points is stored clamped at >= 0, photo_bonus is a non-negative
 * admin-set absolute value, worth is clamped 1-3 by the tasks table's own
 * CHECK constraint, and award points are coerced non-negative at write time
 * (task-badges.awardTaskBadge) or fixed at a known-non-negative constant
 * (AUTO_METRIC_BADGE_POINTS), so total points are always >= 0.
 * @param {number} guestId
 * @returns {number}
 */
function getPoints(guestId) {
  const worthSum = stmtWorthSum.get(guestId).w;
  const photoBonus = stmtPhotoBonusSum.get(guestId).pb;
  const bonusAmountSum = stmtBonusAmountSum.get(guestId).ba;
  const guestRow = stmtBonusPoints.get(guestId);
  const bonus = guestRow ? guestRow.bonus_points : 0;
  const starter = starterTaskContribution(guestRow);
  const starterPoints = starter.done ? starter.points : 0;
  const awardPoints = stmtAwardPointsSum.get(guestId).ap;
  const timezone = getEventConfig().timezone;
  const memoryDays = memoryDayCount(guestId, timezone);
  return worthSum + photoBonus + bonusAmountSum + bonus + starterPoints + awardPoints + memoryDays;
}

// ---------------------------------------------------------------------------
// Auto-badge grant/revoke
// ---------------------------------------------------------------------------

/**
 * Recompute every PER-GUEST badge kind for one guest: (a) the three AUTO
 * threshold badges based on their current completed-task count, and (b) every
 * 'metric' badge in the
 * registry (src/services/badges.js METRIC_BADGES), grant if its compute
 * function returns true, revoke the system row if it returns false. Special
 * and custom (admin-awarded) badges are NEVER touched here — this function
 * only ever writes/deletes `awarded_by = 'system'` rows (AC4).
 *
 * Idempotent: running it repeatedly produces the same end state, so it is
 * safe to call after every submit, takedown, or restore.
 *
 * Wrapped in a transaction so the (possibly multiple) grant/revoke writes
 * either all apply or none do.
 *
 * @param {number} guestId
 */
const recomputeBadges = db.transaction((guestId) => {
  const completed = getCompletedCount(guestId);

  for (const { code, n } of BADGE_THRESHOLDS) {
    const badge = stmtBadgeByCode.get(code);
    if (!badge) {
      // Badge catalog not seeded yet — skip rather than crash. Run seed.js.
      continue;
    }

    const has = stmtGuestBadge.get(guestId, badge.id);

    if (completed >= n) {
      // Threshold met: grant if missing. awarded_by = 'system'. Carries
      // AUTO_METRIC_BADGE_POINTS (issue #709) — an auto badge is worth +1
      // for as long as the guest holds it; revocation below deletes the
      // row, so the point leaves with no separate scoring step.
      if (!has) {
        stmtGrantBadge.run(guestId, badge.id, 'system', AUTO_METRIC_BADGE_POINTS);
      }
    } else {
      // Threshold no longer met: revoke ONLY if it was a system grant.
      // (Defensive: an auto badge should always be system-granted, but we
      // never want to delete an admin-awarded badge by accident.)
      if (has && has.awarded_by === 'system') {
        stmtRevokeBadge.run(guestId, badge.id);
      }
    }
  }

  for (const code of Object.keys(METRIC_BADGES)) {
    const badge = stmtBadgeByCode.get(code);
    if (!badge) {
      // Catalog row not seeded yet — skip rather than crash. Run seed.js.
      continue;
    }

    const qualifies = METRIC_BADGES[code](guestId);
    const has = stmtGuestBadge.get(guestId, badge.id);

    if (qualifies) {
      // Same AUTO_METRIC_BADGE_POINTS grant as the auto branch above — a
      // metric badge (e.g. COMPLETIONIST) is worth +1 for as long as the
      // guest holds it (issue #709).
      if (!has) {
        stmtGrantBadge.run(guestId, badge.id, 'system', AUTO_METRIC_BADGE_POINTS);
      }
    } else if (has && has.awarded_by === 'system') {
      stmtRevokeBadge.run(guestId, badge.id);
    }
  }
});

/**
 * Recompute every 'transferable' badge GLOBALLY (not per-guest): for each
 * transferable catalog row, compute its current holder set from the registry
 * (src/services/badges.js TRANSFERABLE_BADGES), then replace that badge's
 * `awarded_by = 'system'` rows with exactly that set — revoking anyone who
 * dropped out and granting anyone who newly qualifies (including ties, AC2).
 * Admin-awarded rows on the same badge code are never touched (AC4), though
 * in practice a transferable code is refused at admin-award time (AC5) so
 * that case should not arise.
 *
 * Wrapped in a transaction. better-sqlite3 nests transaction functions via
 * SAVEPOINTs, so calling this from inside another db.transaction (e.g.
 * photos.js's hide/restore transaction) is safe.
 */
const recomputeTransferableBadges = db.transaction(() => {
  const transferableCatalog = stmtBadgesByType.all('transferable');

  for (const badge of transferableCatalog) {
    const computeHolders = TRANSFERABLE_BADGES[badge.code];
    if (!computeHolders) {
      // A 'transferable' catalog row with no registered rule — skip rather
      // than crash (defensive; every seeded transferable badge should have one).
      continue;
    }

    const currentHolders = computeHolders();
    const existingSystemHolders = new Set(
      stmtSystemHoldersOfBadge.all(badge.id).map((row) => row.guest_id)
    );

    for (const guestId of existingSystemHolders) {
      if (!currentHolders.has(guestId)) {
        stmtRevokeBadge.run(guestId, badge.id);
      }
    }
    for (const guestId of currentHolders) {
      if (!existingSystemHolders.has(guestId)) {
        // Transferable badges are NOT auto/metric (issue #709) — they stay
        // display-only, so this grant carries points = 0, unchanged from
        // before #709.
        stmtGrantBadge.run(guestId, badge.id, 'system', 0);
      }
    }
  }
});

/**
 * The single recompute seam a data-mutating caller invokes after a submission
 * change (new/replaced submission, takedown, restore). Runs the per-guest
 * pass (auto + metric) and THEN the global transferable pass, in that order —
 * the order that would keep a transferable badge consistent with the
 * guest's just-changed visible-submission count, if any transferable badge
 * is registered (none currently is, #711).
 *
 * This exists so no mutator has to remember the ordered pair itself: a future
 * mutator that adopts only recomputeBadges (forgetting recomputeTransferableBadges)
 * would silently desync any future transferable badge. Both mutators
 * (submissions.js, photos.js) go through here instead.
 *
 * Itself a db.transaction, and better-sqlite3 nests transaction functions via
 * SAVEPOINTs, so it is safe to call from inside photos.js's existing
 * hide/restore transaction as well as standalone from submissions.js.
 *
 * @param {number} guestId - the guest whose submission set just changed.
 */
const recomputeAfterSubmissionChange = db.transaction((guestId) => {
  recomputeBadges(guestId);
  recomputeTransferableBadges();
});

/**
 * The all-guests generalization of recomputeAfterSubmissionChange (issue
 * #701): the seam a caller invokes after the ACTIVE-TASK SET changes
 * (add/hide/un-hide/delete a task) rather than after one guest's own
 * submissions change. Every metric badge (COMPLETIONIST) depends on the
 * current active-task set, not just on the guest who happened to trigger the
 * write, so a task-set change can make ANY guest's Completionist stale —
 * this runs the per-guest pass (auto + metric) for every guest, then the
 * global transferable pass once, same ordered pair and same reasoning as
 * recomputeAfterSubmissionChange.
 *
 * Always runs the FULL pass (not a Completionist-only shortcut) because a
 * task delete cascades its submissions away, which moves the inputs to the
 * count-based auto badges (BLOOM/BOUQUET/GARDEN) and any registered
 * transferable badges too, not just COMPLETIONIST. For add/hide/
 * un-hide, which touch no submission, the auto/transferable recompute for
 * each guest is simply a cheap no-op (their inputs did not change) — no
 * separate code path is worth the duplication.
 *
 * Idempotent (inherited from recomputeBadges/recomputeTransferableBadges,
 * both idempotent themselves) and a safe no-op on an event with zero guests
 * (the for-of loop below just never runs).
 *
 * Itself a db.transaction, and better-sqlite3 nests transaction functions
 * via SAVEPOINTs, so it is safe to call from inside another db.transaction
 * if a future caller needs to.
 */
const recomputeAfterTaskChange = db.transaction(() => {
  const guestIds = stmtAllGuestIds.all();
  for (const { id } of guestIds) {
    recomputeBadges(id);
  }
  recomputeTransferableBadges();
});

// ---------------------------------------------------------------------------
// Special (hand-awarded) badges
// ---------------------------------------------------------------------------

// Badge types the admin may hand-award/remove. 'metric' and 'transferable'
// are system-owned (computed by recomputeBadges/recomputeTransferableBadges)
// and are deliberately excluded here — an admin award/remove request for
// either is refused (issue #80 AC5), so recompute's exclusive ownership of
// those rows can never be bypassed by hand.
const ADMIN_AWARDABLE_TYPES = new Set(['special', 'custom']);

/**
 * Admin hand-awards a SPECIAL or CUSTOM badge to a guest.
 * Validates that the code exists and is of an admin-awardable type (so this
 * can never be used to fake an auto/metric/transferable badge). awarded_by =
 * 'admin'. No-op if already held.
 *
 * @param {number} guestId
 * @param {string} code  a 'special' or 'custom' badge code
 * @returns {boolean} true if a badge was granted (or already present), false if the code was invalid/refused
 */
function awardSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || !ADMIN_AWARDABLE_TYPES.has(badge.type)) {
    return false;
  }
  // ADMIN_AWARDABLE_TYPES is 'special'/'custom' only — never auto/metric
  // (issue #709) — so this grant carries points = 0, unchanged from before
  // #709.
  stmtGrantBadge.run(guestId, badge.id, 'admin', 0);
  return true;
}

/**
 * Admin removes a SPECIAL or CUSTOM badge from a guest.
 * Only removes admin-awardable badge types so this can never strip an
 * auto/metric/transferable (system-owned) badge.
 *
 * @param {number} guestId
 * @param {string} code
 * @returns {boolean} true if the code was a valid admin-awardable badge, false otherwise
 */
function removeSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || !ADMIN_AWARDABLE_TYPES.has(badge.type)) {
    return false;
  }
  stmtRevokeBadge.run(guestId, badge.id);
  return true;
}

/**
 * Admin creates a new host-defined CUSTOM badge in the catalog.
 * Refuses to create a badge whose type is 'metric' or 'transferable'
 * (system-owned types — AC5), or whose code begins with the reserved
 * 'TASK-' prefix (issue #483 AC8 — that prefix is reserved for the per-task
 * badges task-badges.js manages, which never go through this function):
 * either way no row is written and the function returns null. `code` must
 * otherwise be unique (the DB's UNIQUE constraint enforces this; a
 * duplicate throws SqliteError like any other catalog insert would).
 *
 * @param {{code: string, name: string, type: string, artPath: string, description?: string}} params
 * @returns {object|null} the inserted badge row, or null if refused
 */
function createCustomBadge({ code, name, type, artPath, description }) {
  if (!ADMIN_AWARDABLE_TYPES.has(type)) {
    return null;
  }
  if (typeof code === 'string' && code.startsWith(TASK_BADGE_CODE_PREFIX)) {
    return null;
  }
  const info = db
    .prepare(
      `INSERT INTO badges (code, name, type, threshold, art_path, description)
       VALUES (?, ?, ?, NULL, ?, ?)`
    )
    .run(code, name, type, artPath, description || '');
  return db.prepare('SELECT * FROM badges WHERE id = ?').get(info.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Bonus points
// ---------------------------------------------------------------------------

/**
 * Add `delta` to a guest's bonus_points (delta may be negative to deduct).
 * The stored bonus_points is clamped at 0 by the UPDATE (MAX(0, ...)), so a
 * deduction can never push it negative. Returns the guest's new total points
 * so the caller can show it.
 *
 * @param {number} guestId
 * @param {number} delta
 * @returns {number} the guest's new total points
 */
function addBonusPoints(guestId, delta) {
  const amount = Math.trunc(Number(delta)) || 0;
  stmtAddBonus.run(amount, guestId);
  return getPoints(guestId);
}

// ---------------------------------------------------------------------------
// Profile-photo starter task (issue #409; DERIVED per issue #716) — single
// owner of its two facts
// ---------------------------------------------------------------------------

// The hardcoded "Upload your profile photo" starter task is worth this many
// points, owned here the same way a real task's worth column owns its per-
// task base (issue #409 design constraint; issue #727 gave real tasks their
// own worth column, but the starter has no tasks row to carry one). Both
// getPoints/leaderboard's derived starter term (issue #716) and the
// tasks-page tile's "+N pt" label read this one constant, so the value never
// appears as a bare literal at a scoring call site OR in the view.
const STARTER_PHOTO_POINT = 1;

/**
 * The starter task's contribution to a guest's task counts, plus its display
 * facts, derived in ONE place from the guest row (issue #409 design
 * constraint). Every surface that shows, counts, or scores the starter —
 * GET / (home progress bar), GET /tasks (chip counts), views/tasks.ejs (tile
 * placement and label), and getPoints/leaderboard's point totals (issue
 * #716) — consumes this instead of re-deriving `!!avatar_path` or
 * re-applying the `+1` arithmetic on its own, so the surfaces can never
 * disagree about whether the starter exists, is done, or pays.
 *
 * The starter is always exactly one task (`total: 1`); it is complete once
 * the guest has an avatar, and its point ONLY counts toward a guest's total
 * while `done` is true (issue #716 — the point follows the photo: no photo,
 * no point, every time this is read, not just the first time). `done_count`/
 * `todo_count` are the +1 a caller folds into its own done/todo totals.
 *
 * @param {{avatar_path?: string|null}} guest a guest row (e.g. res.locals.guest)
 * @returns {{points:number, done:boolean, total:number, done_count:number, todo_count:number}}
 */
function starterTaskContribution(guest) {
  const done = !!(guest && guest.avatar_path);
  return {
    points: STARTER_PHOTO_POINT,
    done: done,
    total: 1,
    done_count: done ? 1 : 0,
    todo_count: done ? 0 : 1,
  };
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * Public leaderboard: every guest ordered by total points (desc), then by
 * name, then id (stable tiebreak). Total points = SUM of completed tasks'
 * worth (issue #727; a memory contributes no base, issue #247)
 * + per-photo bonus (SUM of submissions.photo_bonus over ALL visible
 * submissions, task or memory — issue #89, preserved by #247's design)
 * + the BANKED one-day-only bonus (SUM of submissions.bonus_amount over ALL
 * visible submissions — issue #753, same banked-at-submit-time value
 * getPoints reads, never re-derived here from tasks.special_date/
 * special_bonus)
 * + guests.bonus_points
 * + the DERIVED profile-photo starter term (issue #716; supersedes #409's
 * one-time banked award): STARTER_PHOTO_POINT while g.avatar_path IS NOT
 * NULL, else 0 — g.avatar_path is only ever NULL or a real filename (never
 * ''), so this SQL presence check is the exact mirror of
 * starterTaskContribution's `!!avatar_path` rule that getPoints reads
 * in-process; the two can't drift because both consume the same
 * STARTER_PHOTO_POINT constant, one via SQL interpolation, one via JS.
 * + the DERIVED memory-day term (issue #656): the SAME memoryDayCount rule
 * getPoints reads, but folded in AFTER the main SQL query runs rather than
 * inside it — SQLite has no IANA timezone support, so the event-local day
 * conversion cannot happen in SQL at all (see memoryDayCountsByGuest, above,
 * built from ONE all-guests query, never a per-guest query inside this
 * function's loop). Because this term lands in JS after the SQL query
 * returns, the SQL query itself carries NO ORDER BY (a SQL-decided order
 * would already be stale by the time this term is added, and would only be
 * discarded) — the JS comparator below the query, applied once the term is
 * folded in, is the single, named owner of standings order; see its own
 * comment for the full key sequence and the NULL-last rule (AC5).
 * + badge AWARD points (SUM of guest_badges.points), counted only while the
 * award's earning photo is visible where one exists (AC6) — see the
 * awardPoints subquery note below. This covers a task-badge judgment amount
 * (issue #483), AUTO_METRIC_BADGE_POINTS for each auto/metric badge the
 * guest currently holds (issue #709 — derived on read, no separate scoring
 * term), and 0 for a transferable/admin-special grant. Each row carries the
 * guest's earned badge codes (auto + special).
 *
 * The completed-count here uses the SAME canonical rule as getCompletedCount
 * (section 1a, Decision A; amended by #247): visible TASK submissions only
 * (taken_down = 0 AND task_id IS NOT NULL), with no liveness filter, so
 * leaderboard points always match a guest's own "X complete" home-page count.
 * bonus_points is clamped >= 0, photo_bonus is a non-negative admin-set
 * value, worth is clamped 1-3 by the tasks table's own CHECK constraint, and
 * award points are coerced non-negative at write time
 * (task-badges.awardTaskBadge), so points >= 0.
 *
 * @returns {Array<{
 *   id: number,
 *   name: string,
 *   avatar_path: string|null,
 *   completed: number,
 *   bonus_points: number,
 *   points: number,
 *   badges: string[]
 * }>}
 */
function leaderboard() {
  // One query computes completed-count and points per guest. We LEFT JOIN
  // submissions filtered to taken_down = 0 so guests with zero (or all
  // taken-down) photos still appear with 0 points, then LEFT JOIN tasks for
  // worth — s.task_id = t.id is a 1:1 relationship (at most one task per
  // submission), so this second join cannot fan out the submissions rows the
  // photo_bonus/worth sums below run over (issue #727's own no-fan-out
  // requirement; verified by the multi-row-with-bonus worth test).
  // COALESCE(SUM(...), 0) covers guests with no visible submissions, where
  // SUM would otherwise contribute SQL NULL to the points expression.
  //
  // "completed" (the display count) counts only TASK-linked visible rows
  // (s.task_id IS NOT NULL) — issue #247: a memory row is visible but not a
  // task completion, so it must not add a base. The worth sum below uses the
  // SAME CASE guard so a memory (t.id NULL via the LEFT JOIN) never
  // contributes t.worth. photo_bonus stays summed over EVERY visible row
  // (task or memory), unchanged from #89 — a memory's admin-awarded bonus
  // still counts (AC10).
  //
  // awardPoints (issue #483) is a CORRELATED SUBQUERY in the SELECT list,
  // NOT an extra JOIN guest_badges added to the outer FROM/GROUP BY above —
  // that outer query is already grouped by g.id over a one-row-per-guest
  // LEFT JOIN submissions; adding a second one-to-many JOIN guest_badges
  // there would fan out (a guest with 2 photos x 1 award = 2 grouped rows
  // before aggregation), inflating BOTH COALESCE(SUM(s.photo_bonus), 0) and
  // the award sum by the fan-out factor. The subquery below runs once per
  // guest row, independent of how many submissions that guest has, so it
  // cannot fan out anything — mirroring stmtAwardPointsSum's guest_badges
  // LEFT JOIN submissions above (same expression, evaluated per-guest there
  // vs. once per leaderboard row here; see the Duplicated-ownership note in
  // this issue's handoff for why the two live as separate query shapes
  // rather than one shared statement, the same pattern already used for the
  // completed-count/photo-bonus terms above).
  const rows = db
    .prepare(
      `SELECT
         g.id            AS id,
         g.name          AS name,
         g.avatar_path   AS avatar_path,
         g.bonus_points  AS bonus_points,
         COUNT(CASE WHEN s.task_id IS NOT NULL THEN 1 END)                                          AS completed,
         COALESCE(SUM(CASE WHEN s.task_id IS NOT NULL THEN t.worth ELSE 0 END), 0) + COALESCE(SUM(s.photo_bonus), 0) + COALESCE(SUM(s.bonus_amount), 0) + g.bonus_points +
         (CASE WHEN g.avatar_path IS NOT NULL THEN ${STARTER_PHOTO_POINT} ELSE 0 END) +
         COALESCE((
           SELECT SUM(gb.points)
             FROM guest_badges gb
             LEFT JOIN submissions gbs ON gbs.id = gb.submission_id
            WHERE gb.guest_id = g.id
              AND (gb.submission_id IS NULL OR gbs.taken_down = 0)
         ), 0) AS points,
         MAX(s.created_at)                                    AS last_submission_at
       FROM guests g
       LEFT JOIN submissions s
         ON s.guest_id = g.id AND ${VISIBLE_WHERE}
       LEFT JOIN tasks t
         ON t.id = s.task_id
       GROUP BY g.id`
    )
    .all();

  // Fold in the memory-day term (issue #656) — computed in JS from ONE
  // all-guests query (memoryDayCountsByGuest), not per-row here, so this
  // stays a single extra query regardless of guest count.
  const timezone = getEventConfig().timezone;
  const memoryDaysByGuest = memoryDayCountsByGuest(timezone);
  for (const row of rows) {
    row.points += memoryDaysByGuest.get(row.id) || 0;
  }

  // SORT — the SINGLE, NAMED owner of standings order (issue #656). The SQL
  // query above intentionally carries no ORDER BY: the memory-day term is
  // folded into `points` in JS, above, AFTER the query runs, so any sort
  // decided in SQL would already be stale by the time this comparator runs
  // and would just be discarded — a second, dead ordering that still looked
  // authoritative. This comparator is therefore the only place standings
  // order is decided, for every guest, every time.
  //
  // Key sequence: points DESC, then "earliest to reach the score" (oldest
  // last_submission_at first) as the tiebreak within an equal-points group,
  // then name ASC, then id ASC as the final stable keys.
  //
  // A guest with no visible submissions has last_submission_at = NULL. NULL
  // must sort LAST within a tie (a guest who never scored must not rank
  // ahead of a guest who did), so the `aNull !== bNull` branch below pushes
  // it there explicitly rather than relying on SQLite's own NULL-ordering
  // rules, which do not apply here since this comparator runs entirely in JS.
  rows.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    const aNull = a.last_submission_at === null;
    const bNull = b.last_submission_at === null;
    if (aNull !== bNull) return aNull ? 1 : -1;
    if (a.last_submission_at !== b.last_submission_at) {
      return a.last_submission_at < b.last_submission_at ? -1 : 1;
    }
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.id - b.id;
  });

  // Attach each guest's badge codes. Done as a second small query per guest;
  // at ~100 guests this is trivially fast.
  const stmtBadgesForGuest = db.prepare(
    `SELECT b.code
       FROM guest_badges gb
       JOIN badges b ON b.id = gb.badge_id
      WHERE gb.guest_id = ?
      ORDER BY b.code ASC`
  );

  for (const row of rows) {
    row.badges = stmtBadgesForGuest.all(row.id).map((r) => r.code);
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Badges a single guest holds (with display fields)
// ---------------------------------------------------------------------------

// Every badge a guest currently holds, joined to the badge catalog so callers
// get the display fields directly. Auto badges come first (ordered by their
// threshold 5 -> 10 -> 15), then special badges by code. gb.points is the
// guest's AWARD points for that specific badge: AUTO_METRIC_BADGE_POINTS for
// an auto/metric grant (issue #709 — held for as long as the guest holds the
// badge), 0 for a transferable/admin-special grant, or a task-badge judgment
// amount for an admin task-badge award (issue #483, task-badges.js
// awardTaskBadge) — stmtGrantBadge sets the first two, awardTaskBadge sets
// the third. gb.created_at and b.id (aliased badge_id)
// are included only so a caller that needs a different display order (e.g.
// community.js's leaderboard/profile "oldest award first" order) can re-sort
// the array it gets back locally instead of re-deriving this join with a
// second SQL statement (issue #487 design-philosophy review) — this
// function stays the ONE place the guest_badges/badges join is written.
const stmtGuestBadgesFull = db.prepare(
  `SELECT b.id AS badge_id, b.code, b.name, b.art_path, b.type, b.description,
          gb.awarded_by, gb.points, gb.created_at
     FROM guest_badges gb
     JOIN badges b ON b.id = gb.badge_id
    WHERE gb.guest_id = ?
    ORDER BY CASE WHEN b.type = 'special' THEN 1 ELSE 0 END ASC,
             b.threshold ASC,
             b.code ASC`
);

/**
 * All badges a guest currently holds, each with { badge_id, code, name,
 * art_path, type, description, awarded_by, points, created_at, pointsLabel }.
 * Used by the section 04 home page, the section 07 public profile (via
 * community.js's re-sorting wrapper), the leaderboard, and the section 08
 * admin guest view.
 *
 * pointsLabel (issue #487) is the ONE place "show a points suffix only when
 * the award is worth something" is decided: "+<points> pts" when points > 0,
 * else '' (falsy, so `<% if (b.pointsLabel) %>` in a template skips it
 * cleanly for a 0-pt badge — AC1/AC2). Every caller renders this precomputed
 * value rather than re-testing `points > 0` itself, so the rule can't drift
 * between the guest-home and public-profile templates.
 * @param {number} guestId
 * @returns {Array<object>}
 */
function getGuestBadges(guestId) {
  return stmtGuestBadgesFull.all(guestId).map((b) => ({
    ...b,
    pointsLabel: b.points > 0 ? `+${b.points} pts` : '',
  }));
}

// ---------------------------------------------------------------------------
// Badge detail page (issue #488): one badge's catalog row + every guest who
// holds it.
// ---------------------------------------------------------------------------

// Every holder of one badge, with the fields the badge detail page needs for
// EITHER of its two rendered shapes (issue #488): a system badge only reads
// guest_id/guest_name; a Wedding Master (custom) badge also reads
// points/note/submission_id/thumb_path per award. One shared query serves
// both — the view decides what to display, this statement never branches on
// badge type.
//
// The LEFT JOIN's ON clause carries the visibility predicate (not a WHERE
// filter), so a taken-down or missing earning photo drops submission_id/
// thumb_path to NULL for that row WITHOUT dropping the guest_badges row itself
// (AC4) — the award's name/points/note must still render, only the photo
// disappears.
//
// The predicate is `${VISIBLE_WHERE}`, consumed from feed.js's single owner
// (the submissions table is aliased `s` here, matching VISIBLE_WHERE's `s.`
// alias) rather than re-deriving the literal. stmtAwardPointsSum (above) and
// the leaderboard main join likewise consume `${VISIBLE_WHERE}` — the two
// clean `s.`-aliased sites migrated by #510. The remaining literals in this
// module (the no-alias single-table counts stmtCompletedCount and
// stmtPhotoBonusSum, and the `gbs`-aliased leaderboard subquery) and in other
// modules stay inlined BY DESIGN: they can't cleanly consume the `s.`-prefixed
// constant. See the ownership-boundary comment at feed.js's VISIBLE_WHERE
// declaration for the why.
const stmtBadgeHolders = db.prepare(
  `SELECT
     g.id         AS guest_id,
     g.name       AS guest_name,
     gb.points    AS points,
     gb.note      AS note,
     s.id         AS submission_id,
     s.thumb_path AS thumb_path
     FROM guest_badges gb
     JOIN guests g ON g.id = gb.guest_id
     LEFT JOIN submissions s ON s.id = gb.submission_id AND ${VISIBLE_WHERE}
    WHERE gb.badge_id = ?
    ORDER BY gb.points DESC, g.name ASC, g.id ASC`
);

/**
 * One badge's catalog row plus every guest who holds it, for the badge
 * detail page (`GET /badge/:code`, issue #488).
 *
 * @param {string} code
 * @returns {{badge: object, holders: Array<object>}|null} null when no badge
 *   with that code exists (the route 404s on this — AC5).
 */
function badgeWithHolders(code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge) {
    return null;
  }
  const holders = stmtBadgeHolders.all(badge.id);
  return { badge, holders };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  BADGE_THRESHOLDS,
  AUTO_THRESHOLDS,
  photoPoints,
  getCompletedCount,
  getPoints,
  memoryDayCount,
  memoryDaysFor,
  getGuestBadges,
  badgeWithHolders,
  recomputeBadges,
  recomputeTransferableBadges,
  recomputeAfterSubmissionChange,
  recomputeAfterTaskChange,
  awardSpecialBadge,
  removeSpecialBadge,
  createCustomBadge,
  addBonusPoints,
  STARTER_PHOTO_POINT,
  starterTaskContribution,
  leaderboard,
};
