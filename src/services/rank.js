// src/services/rank.js
//
// Two pure, DB-free ranking algorithms shared by the leaderboard (dense
// rank, issue #626) and the crowd-favorites engine (standard-competition
// rank, issue #625). Before this module the leaderboard's dense-rank loop
// was written inline in src/routes/community.js's GET /leaderboard handler,
// with no second consumer — issue #625 needed the SAME "walk a sorted list,
// assign ranks" shape but with a DIFFERENT rule for how a tie affects the
// rank that follows it, so the two schemes now live here as two named,
// independently tested functions rather than one inline copy and one
// hand-rolled fork of it.
//
// Both functions take the SAME two-argument shape — a list already sorted
// DESCENDING by the value being ranked, and a `valueOf(item)` accessor — and
// return the SAME shape back: `{ ranks, distinctRankCount }`, where
// `ranks[i]` is `items[i]`'s rank (1-based) and `distinctRankCount` is how
// many distinct rank values appear across the whole list. Neither function
// re-sorts its input: the caller (community.js's leaderboard rows, already
// ordered by scoring.leaderboard()'s own comparator; scoring.js's
// crowdFavorites(), ordered by its own query) is the one place that knows
// the tiebreak rule for equal values, and re-sorting here would risk a
// silent second, disagreeing order.
//
// The two schemes differ ONLY in what a tie does to the rank that follows it:
//   - denseRank:    a tie shares a rank; the NEXT distinct value takes the
//                   very next integer (no gap). [24,20,20,18] -> 1,2,2,3.
//   - standardRank: a tie shares a rank; the NEXT distinct value skips to
//                   1 + however many items came before it (a "race" rank —
//                   1st, 2nd, 2nd, 4th). [24,20,20,18] -> 1,2,2,4.
// See docs/game-design-points-badges.md and this repo's issue #625/#626 for
// why the leaderboard wants the first (a tie must never leave the rank below
// it empty) and crowd favorites wants the second (a tie must consume the
// ranks beneath it, so the paying set stays bounded near 5 regardless of
// party scale).

'use strict';

/**
 * Dense ("1223") rank: a rank increments by exactly 1 each time the value
 * changes from the item before it, so a tie never leaves a gap in the rank
 * sequence. Used by the leaderboard (issue #626), where a tie must never
 * skip a rank number.
 *
 * @param {Array<*>} items - already sorted DESCENDING by valueOf(item).
 * @param {(item: *) => number} valueOf - reads the value to rank by.
 * @returns {{ ranks: number[], distinctRankCount: number }} ranks[i] is
 *   items[i]'s 1-based rank; distinctRankCount is the number of distinct
 *   rank values assigned (0 for an empty list).
 */
function denseRank(items, valueOf) {
  const ranks = new Array(items.length);
  let rank = 0;
  let lastValue = null;
  for (let i = 0; i < items.length; i++) {
    const value = valueOf(items[i]);
    if (lastValue === null || value !== lastValue) {
      rank += 1;
      lastValue = value;
    }
    ranks[i] = rank;
  }
  return { ranks, distinctRankCount: rank };
}

/**
 * Standard-competition ("1224") rank: a tie shares a rank, and the next
 * distinct value skips to `1 + <count of items ranked strictly above it>` —
 * the "race" rule (1st, 2nd, 2nd, 4th) where a tie CONSUMES the ranks
 * beneath it. Used by crowd favorites (issue #625), where that consumption
 * is exactly what keeps the paying set bounded near 5 regardless of how many
 * photos tie for a spot.
 *
 * @param {Array<*>} items - already sorted DESCENDING by valueOf(item).
 * @param {(item: *) => number} valueOf - reads the value to rank by.
 * @returns {{ ranks: number[], distinctRankCount: number }} ranks[i] is
 *   items[i]'s 1-based rank; distinctRankCount is the number of distinct
 *   rank values assigned (0 for an empty list).
 */
function standardRank(items, valueOf) {
  const ranks = new Array(items.length);
  let rank = 0;
  let distinctRankCount = 0;
  for (let i = 0; i < items.length; i++) {
    if (i === 0 || valueOf(items[i]) !== valueOf(items[i - 1])) {
      rank = i + 1;
      distinctRankCount += 1;
    }
    ranks[i] = rank;
  }
  return { ranks, distinctRankCount };
}

module.exports = { denseRank, standardRank };
