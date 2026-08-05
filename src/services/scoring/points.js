// src/services/scoring/points.js
// Per-guest point totals and their terms (issue #969): base photo/task
// points, the memory-day bonus, the profile-photo starter, badge award
// points, and admin bonus-point adjustment. Requires ./crowd-favorites for
// the crowd-favorite term getPoints folds in — the only cross-internal
// scoring dependency this file has; nothing here is required back by
// crowd-favorites.js or badge-engine.js, so there is no cycle.
'use strict';

const { db, getEventConfig } = require('../../db');
const { VISIBLE_WHERE } = require('../feed');
const crowdFavoritesModule = require('./crowd-favorites');
const { crowdPointsByGuest } = crowdFavoritesModule;
const eventDays = require('../event-days');
const { parseSqliteDatetime } = require('../relative-time');

/**
 * Points a single photo is worth. The /feed per-photo display, the
 * end-of-night slideshow, and the guest success card (issue #756) all call
 * this so the base+bonus combination lives only here, never re-typed as a
 * second arithmetic rule at any call site.
 *
 * A TASK photo earns its task's worth (3-5, src/services/tasks.js's
 * MIN_WORTH..MAX_WORTH) plus its admin bonus (photoBonus) plus its BANKED
 * one-day-only challenge bonus (bonusAmount, submissions.bonus_amount, issue
 * #753) — the same three terms getPoints()/leaderboard() sum in aggregate
 * (issue #756 closed the gap between this function and that aggregate rule).
 * A MEMORY (issue #247, task_id IS NULL) earns NO automatic per-photo base —
 * only its admin bonus — matching the aggregate rule, which excludes a
 * memory's base while still counting its photo_bonus. Since issue #656
 * (capped at two per day by issue #1104) the aggregate rule ALSO includes a
 * memory-DAY term (+1 apiece for the guest's first MEMORY_DAILY_PAYING_CAP
 * visible memories each event-local day, derived in getPoints/leaderboard,
 * not here) — this per-photo function has no notion of "day" or the cap, so
 * it still returns 0 for an un-bonused memory; the day term is a separate
 * addition the aggregate makes on top of whatever this function returns for
 * each individual photo. bonusAmount is always 0 for a memory
 * too, since nothing ever banks a one-day-only bonus on one. `worth` and
 * `bonusAmount` both default to 0 (issues #727, #756): a one-arg call yields
 * just `photoBonus`, never NaN, and a memory caller passes worth=0 explicitly
 * for the same reason a task caller passes its task's real worth (>= 3).
 *
 * Deliberate exception (issue #625): a crowd-favorite photo's rank points are
 * NEVER folded in here. This function's number is what a photo earned by
 * being SUBMITTED — a stable, banked-feeling value a feed card can print
 * without explanation. A crowd rank is volatile by design (a later like or
 * takedown can move it on the very next read), so folding it into this
 * per-photo figure would make a card's number flicker for reasons the card
 * cannot explain. What a crowd-favorite photo earns is stated separately: by
 * #788's crown marker on the photo itself, and in the owner's grand total via
 * crowdPointsByGuest() (see getPoints/leaderboard below) — never here.
 *
 * @param {number} photoBonus - the photo's submissions.photo_bonus value
 * @param {number} [worth=0] - the task's worth (3-5), or 0 for a memory
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
// Exported unaliased (issue #1022) so a caller that joins in its own table
// under its own alias — event-stats.js's perTaskCompletion(), which aliases
// submissions `s` — can still compose it: `taken_down`/`task_id` are
// unambiguous against any table this rule is ever joined beside, so no alias
// prefix is needed on either side. leaderboard.js expresses this same rule a
// structurally different way — a conditional aggregate,
// `COUNT(CASE WHEN s.task_id IS NOT NULL THEN 1 END)` (leaderboard.js:122),
// over a `LEFT JOIN submissions` whose join condition (not a WHERE clause)
// carries `${VISIBLE_WHERE}` (leaderboard.js:135) — so it cannot consume
// this constant: COMPLETED_COUNT_WHERE is a WHERE-clause fragment, and
// splicing it into a LEFT JOIN's condition or a WHERE clause after the join
// would silently turn the LEFT JOIN into an INNER JOIN, dropping every guest
// with zero submissions off the leaderboard. Left alone out of scope (issue
// #1022 amendment) because of that shape difference, not because of scope
// alone.
const COMPLETED_COUNT_WHERE = 'taken_down = 0 AND task_id IS NOT NULL';
const stmtCompletedCount = db.prepare(
  `SELECT COUNT(*) AS c FROM submissions WHERE guest_id = ? AND ${COMPLETED_COUNT_WHERE}`
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
// calendar day happens in memoryCountsByDayFor below, via parseSqliteDatetime
// + eventDays.eventLocalDateString, never in SQL (SQLite has no IANA timezone
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
 * Every event-local day on which `guestId` has at least one visible memory
 * (issue #656; day math amended by issue #1104), mapped to that day's
 * visible-memory COUNT — the ONE place the `task_id IS NULL AND taken_down =
 * 0` read (stmtGuestMemoryCreatedAts) plus the parseSqliteDatetime ->
 * eventDays.eventLocalDateString fold runs for a single guest. memoryDaysFor
 * (day IDENTITY, below) and memoryPoints (day POINTS, below) are both thin
 * views over this Map's keys/values, so a UTC/fixed-offset day-math
 * regression can only ever originate here, never separately in either of
 * them.
 * Derived, not banked: a memory row's `created_at` never changes
 * (submissions.js never replaces a memory row), so this is safe to
 * recompute on every read, and a takedown/restore of a day's only memory
 * automatically drops/re-adds that day from the Map with no separate
 * bookkeeping.
 * Day boundary is the EVENT-local date in `timezone` (via
 * eventDays.eventLocalDateString), never server UTC.
 * @param {number} guestId
 * @param {string} timezone - an IANA zone name (db.getEventConfig().timezone).
 * @returns {Map<string, number>} event-local YYYY-MM-DD day string -> that
 *   day's visible-memory count
 */
function memoryCountsByDayFor(guestId, timezone) {
  const rows = stmtGuestMemoryCreatedAts.all(guestId);
  const countsByDay = new Map();
  for (const row of rows) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    const dayIso = eventDays.eventLocalDateString(timezone, instant);
    countsByDay.set(dayIso, (countsByDay.get(dayIso) || 0) + 1);
  }
  return countsByDay;
}

/**
 * The DISTINCT event-local days on which `guestId` has at least one visible
 * memory (issue #656), as a `Set` of `YYYY-MM-DD` strings — day IDENTITY, not
 * the memory-day bonus's point value (memoryPoints, below, sums a per-day cap
 * over this same day grouping, but a day's presence in this Set never implies
 * any particular point count). A thin view over memoryCountsByDayFor's keys,
 * which owns "what counts as a visible memory, and which event-local day it
 * lands on" for the single-guest path (memoryPointsByGuest, below, holds the
 * all-guests copy of that fold over its own one query).
 * There is no in-app consumer of this function today. GET /tasks used to read
 * it for a today-claimed check, but that row was retired by issue #1002 —
 * the price tag it drove is gone, replaced by a plain "Share a memory" button
 * with no claimed state to track. It stays exported and covered because it is
 * the day-IDENTITY guard the day-boundary tests
 * (tests/memory-day-bonus.test.js AC4) assert against directly, so a
 * UTC/fixed-offset day-math regression cannot hide behind the 2-cap in
 * memoryPoints' summed total — it fails here even if it happened to cancel
 * out there.
 * @param {number} guestId
 * @param {string} timezone - an IANA zone name (db.getEventConfig().timezone).
 * @returns {Set<string>} event-local YYYY-MM-DD day strings
 */
function memoryDaysFor(guestId, timezone) {
  return new Set(memoryCountsByDayFor(guestId, timezone).keys());
}

// The memory-day bonus pays at most this many memories per event-local day
// (issue #1104 — rescaled from the original one-memory-per-day bonus, issue
// #656). Owned here, never re-typed as a bare literal at any call site or in
// a test's expected value: cappedDayPoints (below) is this constant's only
// in-app consumer — memoryPoints and memoryPointsByGuest both apply the cap
// through that one helper rather than reading MEMORY_DAILY_PAYING_CAP
// directly — and tests/memories.test.js, tests/memory-day-bonus.test.js, and
// tests/crowd-favorites.test.js import the constant itself so their capped-
// expectation values are derived from it, never re-typed as a bare 2.
const MEMORY_DAILY_PAYING_CAP = 2;

/**
 * The capped-sum formula itself: sum, over a day -> visible-memory-count Map
 * (memoryCountsByDayFor's return for one guest, or one guest's slice of
 * memoryPointsByGuest's per-guest fold), of
 * min(MEMORY_DAILY_PAYING_CAP, that day's count). Owned once so memoryPoints
 * (single guest) and memoryPointsByGuest (all guests) can never compute the
 * cap two different ways.
 * @param {Map<string, number>} countsByDay
 * @returns {number}
 */
function cappedDayPoints(countsByDay) {
  let points = 0;
  for (const count of countsByDay.values()) {
    points += Math.min(MEMORY_DAILY_PAYING_CAP, count);
  }
  return points;
}

/**
 * A guest's memory-day POINTS (issue #656; capped per day by issue #1104):
 * cappedDayPoints applied to memoryCountsByDayFor's per-day counts for this
 * one guest.
 * @param {number} guestId
 * @param {string} timezone - an IANA zone name (db.getEventConfig().timezone).
 * @returns {number}
 */
function memoryPoints(guestId, timezone) {
  return cappedDayPoints(memoryCountsByDayFor(guestId, timezone));
}

/**
 * The all-guests generalization memoryPoints needs for leaderboard(): every
 * guest's memory-day points, computed from ONE query
 * (stmtAllVisibleMemoryCreatedAts) rather than one query per guest, folded
 * into a Map so leaderboard's per-row loop is a plain lookup. Each guest's
 * total is cappedDayPoints applied to that guest's own countsByDay slice —
 * the same formula memoryPoints applies to a single guest.
 * @param {string} timezone
 * @returns {Map<number, number>} guestId -> capped memory-day points
 */
function memoryPointsByGuest(timezone) {
  const countsByGuestDay = new Map();
  for (const row of stmtAllVisibleMemoryCreatedAts.all()) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    const dayIso = eventDays.eventLocalDateString(timezone, instant);
    let countsByDay = countsByGuestDay.get(row.guest_id);
    if (!countsByDay) {
      countsByDay = new Map();
      countsByGuestDay.set(row.guest_id, countsByDay);
    }
    countsByDay.set(dayIso, (countsByDay.get(dayIso) || 0) + 1);
  }
  const points = new Map();
  for (const [guestId, countsByDay] of countsByGuestDay) {
    points.set(guestId, cappedDayPoints(countsByDay));
  }
  return points;
}

// Sum a guest's badge AWARD points (guest_badges.points) over awards whose
// earning photo is currently VISIBLE. Every row written by stmtGrantBadge
// (system/admin grants: auto, metric, transferable, special) carries
// submission_id IS NULL, so the LEFT JOIN's ON clause passes those rows
// through unconditionally regardless of points — an auto grant contributes
// AUTO_METRIC_BADGE_POINTS (issue #709, while held), the metric COMPLETIONIST
// grant contributes CLEAN_SWEEP_BADGE_POINTS instead (issue #1105 split it
// out of the flat auto/metric value), and a transferable/special grant
// contributes 0, but either way there is no submission to gate on. A
// task-badge award's row (written by
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
 *   + the DERIVED memory-day term (issue #656; capped by issue #1104): for
 *     each event-local day on which the guest has >= 1 visible memory, +1 per
 *     memory up to MEMORY_DAILY_PAYING_CAP that day (memoryPoints, above) —
 *     NOT banked (a memory's created_at is stable — submissions.js never
 *     replaces a memory row — so this is safe to recompute on every read; a
 *     takedown/restore of any of a day's memories moves this term
 *     automatically, no separate bookkeeping).
 *   + badge AWARD points (SUM of guest_badges.points), counted only while
 *     the award's earning photo is visible where one exists (AC6). This
 *     term now covers four shapes: a task-badge judgment amount (issue
 *     #483), AUTO_METRIC_BADGE_POINTS for each auto (milestone) badge the
 *     guest currently holds (issue #709), CLEAN_SWEEP_BADGE_POINTS for the
 *     COMPLETIONIST metric badge (issue #1105 split this out of the flat
 *     auto/metric value, since the clean sweep pays more than a milestone
 *     badge), and 0 for a transferable/admin-special grant. The point
 *     derives on read from holding the badge row, and leaves automatically
 *     when recomputeBadges revokes it.
 *   + the DERIVED crowd-favorite term (issue #625, per-guest dedupe #896):
 *     crowdPointsByGuest()'s total for this guest's single BEST liked photo
 *     currently in the placing set (standard-competition rank 1-5 among all
 *     liked photos, memories included, deduped one-per-guest before
 *     ranking). Read fresh on every call, like the memory-day term above —
 *     a guest can hold at most one placing photo, and a photo that drops out
 *     of the placing set (or is overtaken by that guest's OWN better photo)
 *     loses its points on the very next read, with no separate bookkeeping
 *     (AC4).
 * bonus_points is stored clamped at >= 0, photo_bonus is a non-negative
 * admin-set absolute value, worth is clamped 3-5 by the tasks table's own
 * CHECK constraint, and award points are coerced non-negative at write time
 * (task-badges.awardTaskBadge) or fixed at a known-non-negative constant
 * (AUTO_METRIC_BADGE_POINTS or CLEAN_SWEEP_BADGE_POINTS), so total points
 * are always >= 0.
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
  const memoryDayPoints = memoryPoints(guestId, timezone);
  const crowdPoints = crowdPointsByGuest().get(guestId) || 0;
  return (
    worthSum +
    photoBonus +
    bonusAmountSum +
    bonus +
    starterPoints +
    awardPoints +
    memoryDayPoints +
    crowdPoints
  );
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

module.exports = {
  photoPoints,
  getCompletedCount,
  getPoints,
  memoryDaysFor,
  memoryPoints,
  memoryPointsByGuest,
  MEMORY_DAILY_PAYING_CAP,
  addBonusPoints,
  STARTER_PHOTO_POINT,
  starterTaskContribution,
  COMPLETED_COUNT_WHERE,
};
