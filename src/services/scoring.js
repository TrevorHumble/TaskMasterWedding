// src/services/scoring.js
//
// Scoring engine and badge logic for Garden Party Pastels.
//
// Responsibilities:
//   - getPoints / getCompletedCount: how many points a guest has.
//   - recomputeAutoBadges: grant/revoke the auto badges (BLOOM/BOUQUET/GARDEN)
//     based on the guest's current completed-task count. Idempotent.
//   - awardSpecialBadge / removeSpecialBadge: admin-only hand-awarded badges.
//   - addBonusPoints: admin adjusts a guest's bonus point total (clamped at 0).
//   - leaderboard: every guest ordered by total points, with their badge codes.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

// src/db.js exports { db, ... }. Destructure the handle — do NOT write
// `const db = require('../db')` or `db.prepare` is undefined and this file
// crashes at load time on the first prepared statement below.
const { db } = require('../db');

// ---------------------------------------------------------------------------
// Canonical auto-badge thresholds. These MUST match the seeded `badges` rows
// (section 02 seed.js): BLOOM=5, BOUQUET=10, GARDEN=15 completed tasks.
//
// Two shapes are exported on purpose:
//   - BADGE_THRESHOLDS: array of { code, n } objects, used internally by
//     recomputeAutoBadges to map a code to its threshold number.
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

// The base points a visible photo earns just for being shared, before any
// per-photo admin bonus (issue #89). This is the single source of the "1"
// in the per-photo point rule: getPoints and the leaderboard() SQL both
// reference this constant, and the /feed display goes through photoPoints()
// below, so the base never appears as a bare literal at a call site.
const POINTS_PER_PHOTO = 1;

/**
 * Points a single photo is worth: the shared-photo base plus its admin bonus.
 * The /feed per-photo display calls this so the base lives only here, not as a
 * literal in the route.
 * @param {number} photoBonus - the photo's submissions.photo_bonus value
 * @returns {number}
 */
function photoPoints(photoBonus) {
  return POINTS_PER_PHOTO + photoBonus;
}

// ---------------------------------------------------------------------------
// Prepared statements (compiled once, reused on every call for speed).
// ---------------------------------------------------------------------------

// Count a guest's completed tasks = visible submissions (taken_down = 0).
// UNIQUE(guest_id, task_id) guarantees at most one row per task, so this is
// both "submissions that count" and "distinct tasks completed".
//
// CANONICAL completed-count rule (see section 1a, Decision A): we count
// visible submissions regardless of whether the task is still active. There
// is intentionally NO join to `tasks` and NO is_active filter here, so a guest
// keeps points/badges even if the admin later deactivates a task. The guest
// home page must use this same rule for its "X of N complete" numerator.
const stmtCompletedCount = db.prepare(
  'SELECT COUNT(*) AS c FROM submissions WHERE guest_id = ? AND taken_down = 0'
);

// Read a guest's admin-set bonus points.
const stmtBonusPoints = db.prepare('SELECT bonus_points FROM guests WHERE id = ?');

// Sum a guest's per-photo bonus (submissions.photo_bonus, issue #89) over
// their VISIBLE submissions only — same taken_down = 0 guard as
// stmtCompletedCount, so a taken-down photo's bonus never counts (AC6).
// COALESCE(..., 0) covers the guest-has-no-submissions case, where SUM would
// otherwise return SQL NULL.
const stmtPhotoBonusSum = db.prepare(
  'SELECT COALESCE(SUM(photo_bonus), 0) AS pb FROM submissions WHERE guest_id = ? AND taken_down = 0'
);

// Look up a badge row by its code (e.g. 'BLOOM', 'EARLYBIRD').
const stmtBadgeByCode = db.prepare('SELECT * FROM badges WHERE code = ?');

// Does this guest already hold this badge? (returns the guest_badges row or undefined)
const stmtGuestBadge = db.prepare('SELECT * FROM guest_badges WHERE guest_id = ? AND badge_id = ?');

// Grant a badge to a guest. UNIQUE(guest_id, badge_id) prevents duplicates;
// "INSERT OR IGNORE" makes a repeat grant a harmless no-op.
const stmtGrantBadge = db.prepare(
  'INSERT OR IGNORE INTO guest_badges (guest_id, badge_id, awarded_by) VALUES (?, ?, ?)'
);

// Remove a specific badge from a guest.
const stmtRevokeBadge = db.prepare('DELETE FROM guest_badges WHERE guest_id = ? AND badge_id = ?');

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
 * Number of tasks this guest has completed (visible submissions only).
 * Uses the canonical rule: taken_down = 0, ignoring task active state.
 * @param {number} guestId
 * @returns {number}
 */
function getCompletedCount(guestId) {
  const row = stmtCompletedCount.get(guestId);
  return row ? row.c : 0;
}

/**
 * Total points for a guest = completed tasks (1 each)
 *   + per-photo bonus (SUM of submissions.photo_bonus over visible submissions, issue #89)
 *   + admin guests.bonus_points.
 * bonus_points is stored clamped at >= 0, and photo_bonus is a non-negative
 * admin-set absolute value, so total points are always >= 0.
 * @param {number} guestId
 * @returns {number}
 */
function getPoints(guestId) {
  const completed = getCompletedCount(guestId);
  const photoBonus = stmtPhotoBonusSum.get(guestId).pb;
  const bonusRow = stmtBonusPoints.get(guestId);
  const bonus = bonusRow ? bonusRow.bonus_points : 0;
  return completed * POINTS_PER_PHOTO + photoBonus + bonus;
}

// ---------------------------------------------------------------------------
// Auto-badge grant/revoke
// ---------------------------------------------------------------------------

/**
 * Recompute the three AUTO badges for one guest based on their current
 * completed-task count. GRANTS any auto badge whose threshold is met and
 * REVOKES any auto badge whose threshold is no longer met (e.g. after a
 * photo takedown drops the count). Special badges are NEVER touched here.
 *
 * Idempotent: running it repeatedly produces the same end state, so it is
 * safe to call after every submit, takedown, or restore.
 *
 * Wrapped in a transaction so the (possibly multiple) grant/revoke writes
 * either all apply or none do.
 *
 * @param {number} guestId
 */
const recomputeAutoBadges = db.transaction((guestId) => {
  const completed = getCompletedCount(guestId);

  for (const { code, n } of BADGE_THRESHOLDS) {
    const badge = stmtBadgeByCode.get(code);
    if (!badge) {
      // Badge catalog not seeded yet — skip rather than crash. Run seed.js.
      continue;
    }

    const has = stmtGuestBadge.get(guestId, badge.id);

    if (completed >= n) {
      // Threshold met: grant if missing. awarded_by = 'system'.
      if (!has) {
        stmtGrantBadge.run(guestId, badge.id, 'system');
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
});

// ---------------------------------------------------------------------------
// Special (hand-awarded) badges
// ---------------------------------------------------------------------------

/**
 * Admin hand-awards a SPECIAL badge to a guest.
 * Validates that the code exists and is of type 'special' (so this can never
 * be used to fake an auto badge). awarded_by = 'admin'. No-op if already held.
 *
 * @param {number} guestId
 * @param {string} code  one of EARLYBIRD / SHUTTERBUG / CROWDFAV / CHOICE
 * @returns {boolean} true if a badge was granted (or already present), false if the code was invalid
 */
function awardSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || badge.type !== 'special') {
    return false;
  }
  stmtGrantBadge.run(guestId, badge.id, 'admin');
  return true;
}

/**
 * Admin removes a SPECIAL badge from a guest.
 * Only removes badges of type 'special' so this can never strip an auto badge.
 *
 * @param {number} guestId
 * @param {string} code
 * @returns {boolean} true if the code was a valid special badge, false otherwise
 */
function removeSpecialBadge(guestId, code) {
  const badge = stmtBadgeByCode.get(code);
  if (!badge || badge.type !== 'special') {
    return false;
  }
  stmtRevokeBadge.run(guestId, badge.id);
  return true;
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
// Leaderboard
// ---------------------------------------------------------------------------

/**
 * Public leaderboard: every guest ordered by total points (desc), then by
 * name, then id (stable tiebreak). Total points = visible submissions
 * + per-photo bonus (SUM of submissions.photo_bonus over visible submissions,
 * issue #89) + guests.bonus_points. Each row carries the guest's earned badge
 * codes (auto + special).
 *
 * The completed-count here uses the SAME canonical rule as getCompletedCount
 * (section 1a, Decision A): visible submissions only (taken_down = 0), with no
 * is_active filter, so leaderboard points always match a guest's own
 * "X complete" home-page count. bonus_points is clamped >= 0 and photo_bonus
 * is a non-negative admin-set value, so points >= 0.
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
  // taken-down) photos still appear with 0 points. No tasks join / is_active
  // filter — same canonical rule as getCompletedCount. COALESCE(SUM(...), 0)
  // covers guests with no visible submissions, where SUM would otherwise
  // contribute SQL NULL to the points expression. POINTS_PER_PHOTO is a
  // trusted internal integer constant (not user input), interpolated so the
  // per-photo base lives in exactly one place shared with getPoints/photoPoints.
  const rows = db
    .prepare(
      `SELECT
         g.id            AS id,
         g.name          AS name,
         g.avatar_path   AS avatar_path,
         g.bonus_points  AS bonus_points,
         COUNT(s.id)                                          AS completed,
         COUNT(s.id) * ${POINTS_PER_PHOTO} + COALESCE(SUM(s.photo_bonus), 0) + g.bonus_points AS points
       FROM guests g
       LEFT JOIN submissions s
         ON s.guest_id = g.id AND s.taken_down = 0
       GROUP BY g.id
       ORDER BY points DESC, g.name ASC, g.id ASC`
    )
    .all();

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
// threshold 5 -> 10 -> 15), then special badges by code.
const stmtGuestBadgesFull = db.prepare(
  `SELECT b.code, b.name, b.art_path, b.type, b.description, gb.awarded_by
     FROM guest_badges gb
     JOIN badges b ON b.id = gb.badge_id
    WHERE gb.guest_id = ?
    ORDER BY CASE WHEN b.type = 'special' THEN 1 ELSE 0 END ASC,
             b.threshold ASC,
             b.code ASC`
);

/**
 * All badges a guest currently holds, each with { code, name, art_path, type,
 * description, awarded_by }. Used by the section 04 home page, the section 07
 * public profile, and the section 08 admin guest view.
 * @param {number} guestId
 * @returns {Array<object>}
 */
function getGuestBadges(guestId) {
  return stmtGuestBadgesFull.all(guestId);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  BADGE_THRESHOLDS,
  AUTO_THRESHOLDS,
  POINTS_PER_PHOTO,
  photoPoints,
  getCompletedCount,
  getPoints,
  getGuestBadges,
  recomputeAutoBadges,
  awardSpecialBadge,
  removeSpecialBadge,
  addBonusPoints,
  leaderboard,
};
