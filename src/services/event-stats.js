// src/services/event-stats.js
// The admin event stats page's (issue #1022, GET /admin/stats) single data
// owner: plain-value exports, no view formatting (no --v percentages) —
// src/routes/admin/stats.js composes those, and eventDaySeries()'s own
// weekday-abbreviation labels, into copy strings.
//
// Every `created_at` this file reads is parsed through parseSqliteDatetime()
// (src/services/relative-time.js) — never `new Date(row.created_at)` — and
// bucketed into an event-local date/hour through
// event-days.js's eventLocalDateHour(), never SQLite's strftime() (no IANA
// zone support there). See the issue's own "Facts pinned by issue review"
// section for why both of those are load-bearing, not style.
//
// Visibility rules (issue #1022, pinned — four different rules, deliberately):
//   photos (day/hour series, top-line total)  -- feed.VISIBLE_WHERE
//   per-task completion                        -- taken_down=0 AND task_id
//                                                  IS NOT NULL (points.js's
//                                                  own completed-count rule,
//                                                  NOT VISIBLE_WHERE)
//   likes                                       -- VISIBLE_WHERE on the
//                                                  liked submission
//   comments                                    -- feed.COMMENT_VISIBLE_WHERE
//   participation bands                         -- visibility-agnostic: what
//                                                  a guest DID, not what
//                                                  survived moderation
'use strict';

const { db, getEventConfig } = require('../db');
const { VISIBLE_WHERE, COMMENT_VISIBLE_WHERE } = require('./feed');
const { parseSqliteDatetime } = require('./relative-time');
const { COMPLETED_COUNT_WHERE } = require('./scoring/points');
const { eventDays, eventLocalDateHour, weekdayLabels, singleDayLabel } = require('./event-days');

const stmtAllGuestCreatedAts = db.prepare('SELECT created_at FROM guests');
const stmtVisiblePhotoCreatedAts = db.prepare(
  `SELECT created_at FROM submissions s WHERE ${VISIBLE_WHERE}`
);
const stmtVisiblePhotoCount = db.prepare(
  `SELECT COUNT(*) AS n FROM submissions s WHERE ${VISIBLE_WHERE}`
);

/**
 * The whole-event visible-photo count, straight off VISIBLE_WHERE. The
 * top-line "Photos" stat and the pulse line's photo count both read this
 * rather than summing eventDaySeries()'s per-day `photos` column: that
 * column silently drops any row whose created_at fails parseSqliteDatetime()
 * (a day it therefore can't bucket the photo into), which would otherwise
 * quietly under-report the headline total for the same photo the pulse
 * line's relative-time half (feed.newestVisibleSubmission()) still dates.
 * @returns {number}
 */
function totalVisiblePhotoCount() {
  return stmtVisiblePhotoCount.get().n;
}

/**
 * One row per calendar day the event ever touches: the union of every
 * configured event day (eventDays(startDate, endDate)) and every day
 * carrying at least one guest join or visible photo (issue #1022's "Scope
 * rule") -- the union, not the configured range alone, is what guarantees
 * the returned series' joins/photos sums equal the whole-event totals, so
 * the day chart can never silently hide activity outside the configured
 * dates (AC3).
 *
 * Column label (pinned): the weekday abbreviation ("Fri") when no two rows
 * share a weekday; otherwise EVERY row falls back to the "Aug 7" form,
 * all-or-nothing, never a mixed axis.
 *
 * @returns {{ iso: string, label: string, joins: number, photos: number }[]}
 *   ascending by iso.
 */
function eventDaySeries() {
  const { timezone, startDate, endDate } = getEventConfig();
  const configured = eventDays(startDate, endDate);

  const joinsByDate = new Map();
  for (const row of stmtAllGuestCreatedAts.all()) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    const { date } = eventLocalDateHour(timezone, instant);
    joinsByDate.set(date, (joinsByDate.get(date) || 0) + 1);
  }

  const photosByDate = new Map();
  for (const row of stmtVisiblePhotoCreatedAts.all()) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    const { date } = eventLocalDateHour(timezone, instant);
    photosByDate.set(date, (photosByDate.get(date) || 0) + 1);
  }

  const isos = new Set(configured.map((d) => d.iso));
  for (const iso of joinsByDate.keys()) isos.add(iso);
  for (const iso of photosByDate.keys()) isos.add(iso);
  const sortedIsos = Array.from(isos).sort();

  const shortLabels = sortedIsos.map((iso) => weekdayLabels(iso).short);
  const hasDuplicateWeekday = new Set(shortLabels).size !== shortLabels.length;

  return sortedIsos.map((iso, i) => ({
    iso,
    label: hasDuplicateWeekday ? singleDayLabel(iso) : shortLabels[i],
    joins: joinsByDate.get(iso) || 0,
    photos: photosByDate.get(iso) || 0,
  }));
}

/**
 * Exactly 24 rows, hour 0-23, zero-filled, for `dateIso`'s full event-local
 * calendar day, midnight to midnight. Always 24 by construction: these are
 * buckets 0-23, not a walk of the day's real hours, so a DST-transition day
 * (reachable only through eventDaySeries()'s union scope rule, never inside
 * the configured range) merges a repeated local hour into one bucket on a
 * 25-hour day and leaves a skipped one at zero on a 23-hour day — nothing
 * throws and no row is dropped.
 * @param {string} dateIso - YYYY-MM-DD, event-local.
 * @returns {{ hour: number, joins: number, photos: number }[]}
 */
function hourSeries(dateIso) {
  const { timezone } = getEventConfig();
  const joins = new Array(24).fill(0);
  const photos = new Array(24).fill(0);

  for (const row of stmtAllGuestCreatedAts.all()) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    const { date, hour } = eventLocalDateHour(timezone, instant);
    if (date === dateIso) joins[hour] += 1;
  }
  for (const row of stmtVisiblePhotoCreatedAts.all()) {
    const instant = parseSqliteDatetime(row.created_at);
    if (!instant) continue;
    const { date, hour } = eventLocalDateHour(timezone, instant);
    if (date === dateIso) photos[hour] += 1;
  }

  return joins.map((n, hour) => ({ hour, joins: n, photos: photos[hour] }));
}

const stmtVisibleLikeCount = db.prepare(
  `SELECT COUNT(*) AS n FROM likes l JOIN submissions s ON s.id = l.submission_id WHERE ${VISIBLE_WHERE}`
);
const stmtVisibleCommentCount = db.prepare(
  `SELECT COUNT(*) AS n FROM comments c WHERE ${COMMENT_VISIBLE_WHERE}`
);

/**
 * Whole-event likes and comments, both visibility-gated: a like counts only
 * when the liked submission is currently visible (VISIBLE_WHERE, over the
 * join to submissions), a comment counts only when the comment itself is
 * (COMMENT_VISIBLE_WHERE) — a different rule from participationBands() below,
 * which is deliberately visibility-agnostic (see AC5).
 * @returns {{ likes: number, comments: number }}
 */
function engagementTotals() {
  return {
    likes: stmtVisibleLikeCount.get().n,
    comments: stmtVisibleCommentCount.get().n,
  };
}

// SELECT COUNT(*) FROM guests also appears in host-checklist.js's buildRows()
// (issue #1022 review) -- a deliberate second reader, not an oversight: this
// service and the checklist are different contracts (a metrics page here vs.
// a completion checklist there, this issue's own "Context" section) that
// happen to both render a cell labelled "Guests" on different pages. Neither
// composes the other's query, since neither is a subset/superset of the
// other's job -- there is nothing to factor out beyond "count all guests",
// which is already the entire statement.
const stmtGuestCount = db.prepare('SELECT COUNT(*) AS n FROM guests');
const stmtDistinctSubmissionGuestIds = db.prepare('SELECT DISTINCT guest_id FROM submissions');
const stmtDistinctLikeGuestIds = db.prepare('SELECT DISTINCT guest_id FROM likes');
const stmtDistinctCommentGuestIds = db.prepare('SELECT DISTINCT guest_id FROM comments');

/**
 * Three mutually exclusive bands over every guest (issue #1022's replacement
 * for the retired single-ratio participationRatio()), summing to `total`:
 *   - posting: has at least one submissions row, ANY taken_down state —
 *     "Put up at least one photo" counts even if the admin later took it
 *     down (visibility-agnostic by design, the band describes what a guest
 *     DID).
 *   - engagingOnly: no submissions row, but has liked or commented at least
 *     once — also visibility-agnostic: AC5's guest D, whose only act was a
 *     like on a moderated photo, is exactly the case that discriminates this
 *     from a visible-engagement-only rule.
 *   - idle: neither.
 * @returns {{ posting: number, engagingOnly: number, idle: number, total: number }}
 */
function participationBands() {
  const total = stmtGuestCount.get().n;

  const postingGuestIds = new Set(stmtDistinctSubmissionGuestIds.all().map((r) => r.guest_id));
  const engagedGuestIds = new Set();
  for (const r of stmtDistinctLikeGuestIds.all()) engagedGuestIds.add(r.guest_id);
  for (const r of stmtDistinctCommentGuestIds.all()) engagedGuestIds.add(r.guest_id);

  const posting = postingGuestIds.size;
  let engagingOnly = 0;
  for (const guestId of engagedGuestIds) {
    if (!postingGuestIds.has(guestId)) engagingOnly += 1;
  }
  const idle = total - posting - engagingOnly;

  return { posting, engagingOnly, idle, total };
}

// Per-task completion (issue #1022): COMPLETED_COUNT_WHERE (points.js's own
// completed-count predicate, imported rather than re-typed), grouped by
// task_id -- deliberately NOT VISIBLE_WHERE (feed.js's own comment: that
// AND'd clause is a different predicate, not a copy of the bare visibility
// one). COMPLETED_COUNT_WHERE is unaliased; both its columns
// (taken_down, task_id) exist only on submissions, so it composes safely
// unprefixed even though this query joins submissions in under the `s`
// alias. Ties broken by the task's own sort_order ascending -- without it,
// equal-count tasks reorder between renders on SQLite's whim (AC4).
const stmtPerTaskCompletion = db.prepare(`
  SELECT t.id AS taskId, t.title AS title, COUNT(*) AS count
    FROM submissions s
    JOIN tasks t ON t.id = s.task_id
   WHERE ${COMPLETED_COUNT_WHERE}
   GROUP BY t.id
   ORDER BY count DESC, t.sort_order ASC
`);

/**
 * Each task's visible completion count that has at least one, descending,
 * ties broken by the task's own sort_order ascending. The inner JOIN means a
 * task with zero visible submissions is absent from the result entirely, not
 * present with count: 0. A memory (task_id IS NULL) has no task to group
 * under and is likewise absent here (it is still counted in
 * eventDaySeries()'s `photos`, AC4).
 * @returns {{ taskId: number, title: string, count: number }[]}
 */
function perTaskCompletion() {
  return stmtPerTaskCompletion.all();
}

module.exports = {
  eventDaySeries,
  hourSeries,
  engagementTotals,
  participationBands,
  perTaskCompletion,
  totalVisiblePhotoCount,
};
