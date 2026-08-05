// src/services/scoring/couple-hearts.js
// The couple's heart (issue #1107, gold-heart mark shipped by #647): each
// like from a couple-flagged guest (guests.is_couple = 1) pays its owner 1
// point, uncapped across likes and photos, fully derived, no stored row. See
// the section banner below for the full reversal history and rationale
// (modeled on ./crowd-favorites.js's derived-term shape).
'use strict';

const { db } = require('../../db');
const { VISIBLE_WHERE } = require('../feed');

// ---------------------------------------------------------------------------
// The couple's heart (issue #1107): the 2026-07-19 stickiness consult
// (docs/stickiness-consult-2026-07-19.md, N4) originally settled the gold
// heart as paying nothing. The owner reversed that on 2026-08-04 in the
// point-system rebalance session: 1 point per couple like, uncapped, fully
// derived, an un-like removes the point on the very next read, exactly like
// every other derived term in this file's sibling, crowd-favorites.js. The
// consult doc and the matching BUILDLOG.md ship line ("No score effect by
// design") are both dated records and are left unrewritten; DESIGN.md and
// docs/game-design-points-badges.md carry the amendment instead.
// ---------------------------------------------------------------------------

// The single owner of "does this like come from a couple-flagged guest"
// (guests.is_couple = 1). notifications.js's COUPLE_LIKE_EXISTENCE_WHERE and
// community.js's likers-dialog query still hand-type their own copy of this
// same predicate (their migration onto this constant is parked as a
// one-liner on issue #588 per the freeze rule): this module is the natural
// owner, since it is the term's single source of truth for points.
const COUPLE_LIKER_WHERE = 'g.is_couple = 1';

// Every couple-flagged guest's like on a currently VISIBLE submission, worth
// 1 point apiece, summed and grouped by the PHOTO OWNER (s.guest_id), this
// term is added to the photo owner's total, the same target crowdFavorites()
// scores against. Self-likes are already impossible at the route level
// (community.js's POST /p/:submissionId/like, issue #712), so no self-like
// exclusion is needed here, and a couple member's own photo liked by the
// OTHER couple member counts like any other couple like, nothing here
// special-cases who the photo owner is. GROUP BY s.guest_id gives an
// uncapped per-owner total directly: unlike crowd favorites (top-5 placing
// only), there is no ranking or cutoff here, every couple like counts, on
// every photo, forever.
const stmtCoupleLikeCounts = db.prepare(`
  SELECT s.guest_id AS guest_id, COUNT(*) AS points
    FROM likes l
    JOIN submissions s ON s.id = l.submission_id
    JOIN guests g      ON g.id = l.guest_id
   WHERE ${COUPLE_LIKER_WHERE} AND ${VISIBLE_WHERE}
   GROUP BY s.guest_id
`);

/**
 * Each guest's total couple-heart points, from ONE query folded into a Map,
 * the all-guests generalization getPoints/leaderboard both need, built the
 * same way crowdPointsByGuest generalizes crowdFavorites for the same two
 * callers (issue #656's pattern). Uncapped: a guest with couple likes spread
 * across many photos reads the sum of all of them here, no top-N cutoff the
 * way crowd-favorite placement has one.
 * @returns {Map<number, number>} guestId -> total couple-heart points.
 */
function couplePointsByGuest() {
  const totals = new Map();
  for (const row of stmtCoupleLikeCounts.all()) {
    totals.set(row.guest_id, row.points);
  }
  return totals;
}

module.exports = {
  couplePointsByGuest,
  COUPLE_LIKER_WHERE,
};
