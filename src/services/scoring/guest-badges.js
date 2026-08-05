// src/services/scoring/guest-badges.js
// A single guest's held badges (with display fields), celebration-priority
// ranking (issue #714/#902), and the badge detail page's holder list (issue
// #488) — issue #969 split. Requires ./badge-engine for badgeByCode (the
// shared lookup badgeWithHolders needs — see that file's own comment on why
// the underlying statement lives there, not here).
'use strict';

const { db } = require('../../db');
const { VISIBLE_WHERE } = require('../feed');
const { badgeByCode } = require('./badge-engine');
const { isFirstPlaceRank } = require('../task-badges');

// ---------------------------------------------------------------------------
// Badges a single guest holds (with display fields)
// ---------------------------------------------------------------------------

// Every badge a guest currently holds, joined to the badge catalog so callers
// get the display fields directly. Auto badges come first (ordered by their
// threshold ascending — 5 -> 10 -> 15 at the seeded defaults, admin-
// configurable since issue #1094), then special badges by code. gb.points is the
// guest's AWARD points for that specific badge: AUTO_METRIC_BADGE_POINTS for
// an auto (milestone) grant (issue #709 — held for as long as the guest holds
// the badge), CLEAN_SWEEP_BADGE_POINTS for the COMPLETIONIST metric grant
// (issue #1105 split this out of the flat auto/metric value, since the
// clean sweep pays more), 0 for a transferable/admin-special grant, or a task-badge
// judgment amount for an admin task-badge award (issue #483, task-badges.js
// awardTaskBadge) — stmtGrantBadge sets the first three, awardTaskBadge sets
// the fourth. gb.created_at and b.id (aliased badge_id)
// are included only so a caller that needs a different display order (e.g.
// community.js's leaderboard/profile "oldest award first" order) can re-sort
// the array it gets back locally instead of re-deriving this join with a
// second SQL statement (issue #487 design-philosophy review) — this
// function stays the ONE place the guest_badges/badges join is written.
//
// task_id/rank/submission_id/submission_visible (issue #489) are additive
// projection columns for the leaderboard's earned-badge display (gold rank-1
// treatment, winning-photo link). Every other caller (guest home, public
// profile, admin guest view, rankBadgeCandidates) ignores them, exactly like
// it already ignores awarded_by/created_at. submission_visible is a LEFT
// JOIN CASE, not a WHERE filter, so a taken-down or missing earning photo
// reads 0 without dropping the guest_badges row itself (mirrors
// stmtBadgeHolders' own visibility-in-the-JOIN pattern below). The join is
// aliased `gbs`, not `s`, so it cannot cleanly consume feed.js's `s.`-aliased
// VISIBLE_WHERE constant. See that constant's own declaration-site comment
// on differently-aliased subqueries keeping their own literal by design.
const stmtGuestBadgesFull = db.prepare(
  `SELECT b.id AS badge_id, b.code, b.name, b.art_path, b.type, b.threshold, b.description,
          b.task_id AS task_id,
          gb.awarded_by, gb.points, gb.created_at, gb.rank, gb.submission_id,
          CASE WHEN gbs.taken_down = 0 THEN 1 ELSE 0 END AS submission_visible
     FROM guest_badges gb
     JOIN badges b ON b.id = gb.badge_id
     LEFT JOIN submissions gbs ON gbs.id = gb.submission_id
    WHERE gb.guest_id = ?
    ORDER BY CASE WHEN b.type = 'special' THEN 1 ELSE 0 END ASC,
             b.threshold ASC,
             b.code ASC`
);

/**
 * All badges a guest currently holds, each with { badge_id, code, name,
 * art_path, type, threshold, description, awarded_by, points, created_at,
 * pointsLabel }. Used by the section 04 home page, the section 07 public
 * profile (via community.js's re-sorting wrapper), the leaderboard, the
 * section 08 admin guest view, and (issue #714) rankBadgeCandidates below,
 * which is the reason `threshold` rides along on every row rather than being
 * a second query only that caller runs.
 *
 * pointsLabel (issue #487) is the ONE place "show a points suffix only when
 * the award is worth something" is decided: "+<points> pts" when points > 0,
 * else '' (falsy, so `<% if (b.pointsLabel) %>` in a template skips it
 * cleanly for a 0-pt badge, AC1/AC2). Every caller renders this precomputed
 * value rather than re-testing `points > 0` itself, so the rule can't drift
 * between the guest-home and public-profile templates.
 *
 * isTaskMaster and isFirstPlaceTaskWin (issue #489) are the same kind of
 * precomputed decode: isTaskMaster is `task_id != null` (a task-badge award,
 * as opposed to a system/custom badge with no owning task), and
 * isFirstPlaceTaskWin is the whole gold-treatment rule as ONE owned flag: a
 * task award (task_id set) that also placed first, deferring the rank-1 half
 * to task-badges.js's isFirstPlaceRank, the single owner of that decode
 * (issue #611). Both live here, not in a caller's template, for the same
 * reason pointsLabel does: one place decides the business rule, every renderer
 * just reads the flag. (What the leaderboard still composes in its own view is
 * presentation only: the CSS class name and the winning-photo URL grammar,
 * neither of which belongs in this data layer.)
 * @param {number} guestId
 * @returns {Array<object>}
 */
function getGuestBadges(guestId) {
  return stmtGuestBadgesFull.all(guestId).map((b) => ({
    ...b,
    pointsLabel: b.points > 0 ? `+${b.points} pts` : '',
    isTaskMaster: b.task_id != null,
    isFirstPlaceTaskWin: b.task_id != null && isFirstPlaceRank(b.rank),
  }));
}

// ---------------------------------------------------------------------------
// Celebration priority (issue #714): which of several newly-earned badges the
// guest.js task-complete modal features, when a single submit crosses more
// than one badge at once.
// ---------------------------------------------------------------------------

// Ranks a badge's `type`, never its `code` — the whole point of this issue is
// that no badge code appears anywhere in the ordering rule (see the issue's
// "derived rule" section). auto outranks metric so an auto badge (BLOOM/
// BOUQUET/GARDEN) still wins over COMPLETIONIST, reproducing #255's shipped
// choice. The map covers every value badges.type's CHECK constraint permits
// today (src/db.js) — auto/special/metric/transferable/custom — so the
// UNRANKED_BADGE_TYPE_RANK fallback below is unreachable through the database;
// it exists only so that widening that CHECK later without touching this map
// degrades to "sorts last" instead of an undefined rank poisoning the
// comparison with NaN.
const BADGE_TYPE_RANK = {
  auto: 0,
  metric: 1,
  transferable: 2,
  custom: 3,
  special: 4,
};

// The rank an unlisted type takes. Deliberately NOT "one past the current
// last entry": a literal like 5 stops meaning "last" the moment someone adds
// a sixth type to the map above and gives it that number, at which point a
// still-unlisted type would tie with a listed one instead of sorting behind
// it — and no test would notice.
const UNRANKED_BADGE_TYPE_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Pure comparator ordering two badge-shaped objects ({ type, threshold, code })
 * by celebration priority: type rank ascending, then threshold descending (a
 * higher completed-task threshold is the more impressive badge — 15 beats 10
 * beats 5 at the seeded defaults; the actual numbers are admin-configurable,
 * issue #1094, but a higher threshold stays the more impressive badge either
 * way), then code ascending as a deterministic tiebreak so two badges
 * identical on the first two keys never fall back to array order. Exported
 * (AC3) because badges.type's CHECK constraint makes the unlisted-type branch
 * unreachable through the database — a synthetic row passed straight to this
 * function is the only way to exercise it.
 *
 * Always returns a finite number, never NaN or undefined: an unlisted `type`
 * takes UNRANKED_BADGE_TYPE_RANK (sorts last), and a `null` or non-numeric
 * `threshold` sorts last within its own type rank rather than comparing as
 * NaN against a real number. The threshold step returns a sign rather than a
 * difference so its -Infinity sentinel can never leak out as the result.
 *
 * @param {{type: string, threshold: ?number, code: string}} a
 * @param {{type: string, threshold: ?number, code: string}} b
 * @returns {number} negative if a precedes b, positive if b precedes a, 0 if tied
 */
function compareBadgeMoment(a, b) {
  const rankA = BADGE_TYPE_RANK[a.type] ?? UNRANKED_BADGE_TYPE_RANK;
  const rankB = BADGE_TYPE_RANK[b.type] ?? UNRANKED_BADGE_TYPE_RANK;
  if (rankA !== rankB) {
    return rankA - rankB;
  }

  // typeof-guard rather than `?? -Infinity`: `??` only substitutes for
  // null/undefined, so a non-numeric threshold (defensive; the column is
  // INTEGER but a synthetic AC3 row could hand this any shape) would still
  // reach a numeric subtraction and produce NaN without this check.
  const thresholdA = typeof a.threshold === 'number' ? a.threshold : -Infinity;
  const thresholdB = typeof b.threshold === 'number' ? b.threshold : -Infinity;
  if (thresholdA !== thresholdB) {
    // A sign, not `thresholdB - thresholdA`: subtracting the -Infinity
    // sentinel would return ±Infinity as this comparator's own result. Sorting
    // reads only the sign either way, but a caller inspecting the number (a
    // test, a future re-use) should never see the sentinel leak out.
    return thresholdA > thresholdB ? -1 : 1; // descending: higher threshold first
  }

  // Deterministic tiebreak — never the order the caller's array arrived in.
  if (a.code < b.code) return -1;
  if (a.code > b.code) return 1;
  return 0;
}

/**
 * Reduce this guest's FULL held-badge set (getGuestBadges — the only query
 * that carries the `type`/`threshold` compareBadgeMoment ranks on) down to
 * just the candidate `codes`, then order what's left by celebration
 * priority. The single owner of "which of several newly-owed badges wins the
 * celebration slot, and in what order do the rest follow" (issue #714,
 * widened by #902): originally written to answer just the single-winner
 * question for a task-complete submit crossing more than one badge at once
 * (`ranked[0]`, guest.js's task-complete modal), and reused unchanged by
 * render-locals.js's resolveBadgeMoment to build the WHOLE owed celebration
 * queue instead (issue #902 plan step 1) — one owner of "filter held badges
 * to a candidate set, ranked," not two independent copies of the same
 * two-step rule.
 *
 * Returns `[]` immediately for an empty or non-array `codes`, before calling
 * getGuestBadges — a no-badge submit is the common case (every ordinary task
 * completion) and must not gain a getGuestBadges query on that path (#714).
 *
 * @param {number} guestId
 * @param {Array<string>} codes - candidate badge codes to rank. A code the
 *   guest does not currently hold is silently dropped (not expected to
 *   happen for a caller resolving codes it just read off this same guest's
 *   own held/owed rows, but degrades to "skip it" rather than throwing).
 * @returns {Array<object>} held badges (getGuestBadges shape) matching
 *   `codes`, ordered by compareBadgeMoment. Empty when nothing matches.
 */
function rankBadgeCandidates(guestId, codes) {
  if (!Array.isArray(codes) || codes.length === 0) {
    return [];
  }
  const codeSet = new Set(codes);
  const matched = getGuestBadges(guestId).filter((b) => codeSet.has(b.code));
  matched.sort(compareBadgeMoment);
  return matched;
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
  const badge = badgeByCode(code);
  if (!badge) {
    return null;
  }
  const holders = stmtBadgeHolders.all(badge.id);
  return { badge, holders };
}

module.exports = {
  getGuestBadges,
  compareBadgeMoment,
  rankBadgeCandidates,
  badgeWithHolders,
};
