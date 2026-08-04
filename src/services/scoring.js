// src/services/scoring.js
//
// Scoring engine and badge logic entry (issue #969 split). Internals live
// under src/services/scoring/: points.js (per-guest point totals),
// crowd-favorites.js (the derived crowd-favorite placing set),
// badge-engine.js (auto/metric/transferable grant-revoke + admin hand-award),
// leaderboard.js (the public standings), and guest-badges.js (a guest's held
// badges, celebration-priority ranking, and the badge detail page). This
// file's own require path (`require('./scoring')`/`require('../services/
// scoring')`) and full public API are unchanged.
//
// Unlike src/db.js's internals, each scoring internal prepares its own
// db.prepare/db.transaction statements at ITS OWN module load, rather than
// receiving `db` as a parameter — safe here (unlike src/db/'s internals)
// because every caller reaches this file via `require('../services/scoring')`
// (or a sibling internal's own require), and by the time ANY of those
// resolve, `require('../db')` has already fully evaluated and the database
// is open — scoring is never independently evicted from require.cache the
// way src/db.js and src/db/connection.js are in the class-4 migration tests
// (only the db entry + connection are evicted there), so a scoring internal
// never runs the risk of surviving into a second boot with a stale handle.
'use strict';

const points = require('./scoring/points');
const crowdFavorites = require('./scoring/crowd-favorites');
const badgeEngine = require('./scoring/badge-engine');
const leaderboardModule = require('./scoring/leaderboard');
const guestBadges = require('./scoring/guest-badges');

module.exports = {
  BADGE_THRESHOLD_MIN: badgeEngine.BADGE_THRESHOLD_MIN,
  BADGE_THRESHOLD_MAX: badgeEngine.BADGE_THRESHOLD_MAX,
  autoBadgeThresholds: badgeEngine.autoBadgeThresholds,
  autoBadgeRows: badgeEngine.autoBadgeRows,
  badgeByCode: badgeEngine.badgeByCode,
  cleanSweepBadgeName: badgeEngine.cleanSweepBadgeName,
  photoPoints: points.photoPoints,
  getCompletedCount: points.getCompletedCount,
  getPoints: points.getPoints,
  memoryDayCount: points.memoryDayCount,
  memoryDaysFor: points.memoryDaysFor,
  CROWD_FAVORITE_POINTS: crowdFavorites.CROWD_FAVORITE_POINTS,
  crowdFavorites: crowdFavorites.crowdFavorites,
  crowdPointsByGuest: crowdFavorites.crowdPointsByGuest,
  recordCrowdFavoriteChanges: crowdFavorites.recordCrowdFavoriteChanges,
  getGuestBadges: guestBadges.getGuestBadges,
  compareBadgeMoment: guestBadges.compareBadgeMoment,
  rankBadgeCandidates: guestBadges.rankBadgeCandidates,
  badgeWithHolders: guestBadges.badgeWithHolders,
  thresholdCompletedCount: badgeEngine.thresholdCompletedCount,
  nextThresholdBadge: badgeEngine.nextThresholdBadge,
  recomputeThresholdBadges: badgeEngine.recomputeThresholdBadges,
  recomputeBadges: badgeEngine.recomputeBadges,
  recomputeTransferableBadges: badgeEngine.recomputeTransferableBadges,
  recomputeAfterSubmissionChange: badgeEngine.recomputeAfterSubmissionChange,
  recomputeAfterTaskChange: badgeEngine.recomputeAfterTaskChange,
  setAutoBadgeThresholds: badgeEngine.setAutoBadgeThresholds,
  awardSpecialBadge: badgeEngine.awardSpecialBadge,
  removeSpecialBadge: badgeEngine.removeSpecialBadge,
  createCustomBadge: badgeEngine.createCustomBadge,
  addBonusPoints: points.addBonusPoints,
  STARTER_PHOTO_POINT: points.STARTER_PHOTO_POINT,
  starterTaskContribution: points.starterTaskContribution,
  leaderboard: leaderboardModule.leaderboard,
};
