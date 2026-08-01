// src/services/scoring/crowd-favorites.js
// Crowd favorites (issue #625, per-guest dedupe #896) — the crowd's likes
// vote on the weekend's best photos, fully derived, no stored row. See the
// original section banner below for the full "why derived, not stored"
// rationale.
'use strict';

const { db } = require('../../db');
const { VISIBLE_WHERE } = require('../feed');
const rank = require('../rank');
const notifications = require('../notifications');

// ---------------------------------------------------------------------------
// Crowd favorites (issue #625, per-guest dedupe reversal #896): the crowd's
// likes vote on the weekend's best photos, fully derived — no `guest_badges`
// row is ever written for a crowd-favorite placement. Binding rationale:
// `guest_badges` carries `CONSTRAINT uq_gb UNIQUE (guest_id, badge_id)`
// (src/db.js), so materializing a crowd-favorite placement as a row on that
// table would still need a `submission_id` column no other badge kind
// carries, purely to identify WHICH of a guest's photos earned the row —
// even though #896 now guarantees at most one placing photo per guest, that
// photo can change from one read to the next as likes/takedowns move the
// standings, and a stored row would go stale exactly like every other
// derived scoring term in this file. crowdFavorites() below is the ONLY
// place "who is a crowd favorite, at what rank, worth how much" is decided;
// every reader (getPoints, leaderboard, feed.slideshowSequence's Most Liked
// opener, notifications.js's crowd_favorite/crowd_favorite_lost recap rows)
// reads this same live answer rather than a stored copy that could go stale
// the moment a like/takedown/restore moves it.
// ---------------------------------------------------------------------------

// Rank -> points, index by (rank - 1). Ranks 1-5 place; a photo at rank 6 or
// below, or with 0 likes, never appears in crowdFavorites()'s output at all.
const CROWD_FAVORITE_POINTS = [5, 4, 3, 2, 1];

// Every VISIBLE submission with at least one like, its owner, and its like
// count — the ranking input crowdFavorites() below sorts and ranks in JS.
// Composes VISIBLE_WHERE (feed.js's single owner of "a submission is
// visible") rather than hand-typing a second `taken_down = 0` predicate.
// like_count is filtered to > 0 in the OUTER query (a derived-table column
// alias cannot be referenced from the WHERE clause of the query that
// computes it — SQLite evaluates WHERE before the SELECT list), and NO
// task_id filter appears anywhere here: a memory competes exactly like a
// task photo (issue #625's settled "memories compete" rule). Ordered
// like_count DESC with submission_id ASC as a deterministic tiebreak (SQL
// gives no ordering guarantee among equal like_count rows on its own), so
// rank.standardRank below always sees the same order for the same data.
const stmtVisibleLikeCounts = db.prepare(`
  SELECT submission_id, guest_id, like_count FROM (
    SELECT s.id       AS submission_id,
           s.guest_id AS guest_id,
           (SELECT COUNT(*) FROM likes l WHERE l.submission_id = s.id) AS like_count
      FROM submissions s
     WHERE ${VISIBLE_WHERE}
  )
 WHERE like_count > 0
 ORDER BY like_count DESC, submission_id ASC
`);

/**
 * The crowd-favorite placing set, live, from ONE query (issue #625 AC8: the
 * leaderboard's caller must be able to call this exactly once regardless of
 * guest count). Issue #896 reversed #625 AC3's old "no-cap sweep" rule: each
 * guest now appears AT MOST ONCE in the placing set, represented by their
 * single BEST visible liked photo (highest like_count, then lowest
 * submission_id tiebreak). stmtVisibleLikeCounts is already ordered
 * `like_count DESC, submission_id ASC`, so that order makes the FIRST row
 * seen for a given guest_id exactly that guest's best photo — the dedupe
 * below is a single pass keeping only first-seen guest_ids, no second query
 * and no re-sort. Dedupe happens BEFORE ranking, so each guest consumes only
 * the one rank their best photo earns; nobody else's rank shifts as a result
 * except by that guest's other photos simply not being counted.
 *
 * Standard-competition ranking (rank.standardRank, deliberately NOT the
 * leaderboard's dense rank, #626) then runs over the DEDUPED list: a tie
 * shares a rank and the next distinct like count skips to `1 + <count of
 * photos ranked above it>`, so a big tie for a spot CONSUMES the ranks
 * beneath it — the rule that keeps the paying set bounded near 5 regardless
 * of party scale (a 60-photo tail all sitting at 1 like never all place,
 * unlike dense ranking, which has no such bound). Ranks 1-5 place, paying
 * CROWD_FAVORITE_POINTS[rank - 1]; a photo ranked 6th or worse, sitting at 0
 * likes (excluded by stmtVisibleLikeCounts before ranking even runs), or
 * deduped out as a non-best photo of a guest who already placed, never
 * appears in the returned array. A single tier that itself holds 5+
 * DIFFERENT guests' best photos (a big top tie) can still place more than 5
 * — that is correct: they genuinely tied for most-liked (issue #625's own
 * wording) — but a tie no longer inflates a single guest's own placement
 * count, only the field's.
 * @returns {Array<{submission_id: number, guest_id: number, like_count:
 *   number, rank: number, points: number}>} best rank first; at most one
 *   row per guest_id (#896).
 */
function crowdFavorites() {
  const rows = stmtVisibleLikeCounts.all();

  // Keep only each guest's first-seen row — their best photo, since rows
  // arrive ordered like_count DESC, submission_id ASC (issue #896).
  const seenGuestIds = new Set();
  const bestPerGuest = [];
  for (const row of rows) {
    if (seenGuestIds.has(row.guest_id)) {
      continue;
    }
    seenGuestIds.add(row.guest_id);
    bestPerGuest.push(row);
  }

  const { ranks } = rank.standardRank(bestPerGuest, (row) => row.like_count);
  const placing = [];
  for (let i = 0; i < bestPerGuest.length; i++) {
    if (ranks[i] > CROWD_FAVORITE_POINTS.length) {
      // Ranks only ever increase as i advances (bestPerGuest is still sorted
      // DESC by like_count — dedupe drops rows, it never reorders them), so
      // once one row's rank exceeds the paying cutoff every row after it
      // does too — safe to stop scanning early.
      break;
    }
    placing.push({
      submission_id: bestPerGuest[i].submission_id,
      guest_id: bestPerGuest[i].guest_id,
      like_count: bestPerGuest[i].like_count,
      rank: ranks[i],
      points: CROWD_FAVORITE_POINTS[ranks[i] - 1],
    });
  }
  return placing;
}

/**
 * Each guest's total crowd-favorite points, folded from ONE crowdFavorites()
 * call into a Map — the all-guests generalization getPoints/leaderboard both
 * need, built the same way memoryDayCountsByGuest generalizes
 * memoryDayCount for the same two callers (issue #656's pattern). Since issue
 * #896, crowdFavorites() already guarantees at most one placing entry per
 * guest_id, so this is a plain per-guest sum over an input that can add at
 * most one term per guest — the Map's value is always exactly that guest's
 * single placing photo's points, never a sweep total.
 * @returns {Map<number, number>} guestId -> total crowd-favorite points.
 */
function crowdPointsByGuest() {
  const totals = new Map();
  for (const placing of crowdFavorites()) {
    totals.set(placing.guest_id, (totals.get(placing.guest_id) || 0) + placing.points);
  }
  return totals;
}

/**
 * Diff the crowd-favorite placing set BEFORE a mutation (a like toggle, a
 * takedown, or a restore — every caller captures `before` via
 * crowdFavorites() immediately before its own write) against the CURRENT
 * set, KEYED BY GUEST_ID (issue #895, superseding #625 AC7's old
 * submission-keyed diff): emit exactly one recap event per guest whose
 * PLACING STATUS actually changed — entered the set -> 'crowd_favorite' to
 * that guest; left the set entirely -> 'crowd_favorite_lost'. A guest who
 * remains in the set emits nothing, no matter WHY crowdFavorites() reports
 * them again: a pure rank shuffle from someone else's like changing nothing
 * about this guest's own membership, or (since #896) a representative-photo
 * swap when a guest's own previously-second-best tied photo overtakes their
 * old best — neither is news, since the guest's placing FACT (in vs. out)
 * never changed. (#625's original rule — "entered or moved rank" — is what
 * #895 fixes: a rank move alone is not itself news.) No stale rank is ever
 * stored: the recap row carries only guest_id + submission_id
 * (notifications.recordEvent), and reads the CURRENT rank/points from
 * crowdFavorites() again at render time, keyed by guest_id
 * (notifications.js's KIND_VIEW.crowd_favorite.parts()) so a later
 * representative-photo swap can never strand a stored row on a submission_id
 * that has stopped representing the guest.
 * @param {Array<{submission_id: number, guest_id: number, rank: number}>} before
 *   - the return of crowdFavorites(), captured before the caller's mutation;
 *   at most one row per guest_id (#896).
 */
function recordCrowdFavoriteChanges(before) {
  const after = crowdFavorites();
  const beforeByGuest = new Map(before.map((p) => [p.guest_id, p]));
  const afterByGuest = new Map(after.map((p) => [p.guest_id, p]));

  for (const [guestId, afterPlacing] of afterByGuest) {
    if (!beforeByGuest.has(guestId)) {
      notifications.recordEvent(guestId, 'crowd_favorite', {
        submissionId: afterPlacing.submission_id,
      });
    }
  }
  for (const [guestId, beforePlacing] of beforeByGuest) {
    if (!afterByGuest.has(guestId)) {
      notifications.recordEvent(guestId, 'crowd_favorite_lost', {
        submissionId: beforePlacing.submission_id,
      });
    }
  }
}

module.exports = {
  CROWD_FAVORITE_POINTS,
  crowdFavorites,
  crowdPointsByGuest,
  recordCrowdFavoriteChanges,
};
