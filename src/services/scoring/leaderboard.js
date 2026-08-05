// src/services/scoring/leaderboard.js
// Public leaderboard (issue #969): every guest ordered by total points, with
// badge codes attached. Requires ./points (the starter-point constant and
// the all-guests memory-day fold) and ./crowd-favorites (the all-guests
// crowd-favorite fold) — the same two derived terms getPoints folds in for a
// single guest.
'use strict';

const { db, getEventConfig } = require('../../db');
const { VISIBLE_WHERE } = require('../feed');
const { STARTER_PHOTO_POINT, memoryDayCountsByGuest } = require('./points');
const { crowdPointsByGuest } = require('./crowd-favorites');

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
 * + the DERIVED crowd-favorite term (issue #625): the SAME crowdPointsByGuest()
 * rule getPoints reads, folded in AFTER the main SQL query runs — exactly
 * like the memory-day term below, and for the identical reason (standard-
 * competition ranking over a live like count cannot be expressed as a SQL
 * expression scoped to one guest row without fanning out). crowdPointsByGuest()
 * itself issues exactly ONE query regardless of guest count (AC8) — a single
 * crowdFavorites() call ranks every liked photo in the whole event once, then
 * this loop is a plain per-guest Map lookup.
 *
 * The completed-count here uses the SAME canonical rule as getCompletedCount
 * (section 1a, Decision A; amended by #247): visible TASK submissions only
 * (taken_down = 0 AND task_id IS NOT NULL), with no liveness filter, so
 * leaderboard points always match a guest's own "X complete" home-page count.
 * bonus_points is clamped >= 0, photo_bonus is a non-negative admin-set
 * value, worth is clamped 3-5 by the tasks table's own CHECK constraint, and
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

  // Fold in the crowd-favorite term (issue #625) — ONE crowdPointsByGuest()
  // call (which itself makes exactly ONE crowdFavorites() query, AC8),
  // folded in JS the same way and for the same reason as the memory-day term
  // just above: standard-competition rank over a live like count cannot be
  // expressed as a per-guest SQL expression without fanning out the query.
  const crowdPointsByGuestMap = crowdPointsByGuest();
  for (const row of rows) {
    row.points += crowdPointsByGuestMap.get(row.id) || 0;
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

module.exports = { leaderboard };
