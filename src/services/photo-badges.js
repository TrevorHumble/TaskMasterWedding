// src/services/photo-badges.js
//
// The "give a badge" photo-winner picker on the admin photos screen (issue
// #259): a fixed 5-badge catalog the Wedding Master chooses winning photos
// from. Awarding a badge to a photo records it in badge_winners (src/db.js);
// a badge's "N/5" count is COUNT(*) over its winner rows.
//
// DISTINCT from the guest special-badge catalog in the `badges` table
// (src/db.js) that src/services/scoring.js and POST /admin/guests/:id/badge
// own: SHUTTERBUG/CHOICE/CROWDFAV happen to share a name with three codes
// here, but they are a different concept — that catalog hand-awards a badge
// to a GUEST; this one marks a PHOTO as a category winner, and never touches
// guest_badges or a guest's points. No points are written by this module at
// all: ranking + point release read badge_winners, but that happens in issue
// #661, not here.
//
// The 5-code catalog is a code CONSTANT, not a DB table — there is no
// host-facing CRUD for it in this issue, so badge_code on badge_winners is a
// plain TEXT column (not a foreign key into another catalog table). Badges
// carry no emoji (owner rule, issue #259).
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

const { db } = require('../db');

const PHOTO_BADGES = [
  { code: 'SHUTTERBUG', name: 'Shutterbug' },
  { code: 'CHOICE', name: "Couple's Choice" },
  { code: 'BESTDANCE', name: 'Best Dance Move' },
  { code: 'GOLDEN', name: 'Golden Hour' },
  { code: 'CROWDFAV', name: 'Crowd Favorite' },
];

const PHOTO_BADGE_BY_CODE = new Map(PHOTO_BADGES.map((b) => [b.code, b]));

const stmtInsertWinner = db.prepare(
  'INSERT OR IGNORE INTO badge_winners (badge_code, submission_id) VALUES (?, ?)'
);
const stmtDeleteWinner = db.prepare(
  'DELETE FROM badge_winners WHERE badge_code = ? AND submission_id = ?'
);
const stmtIsWinner = db.prepare(
  'SELECT 1 FROM badge_winners WHERE badge_code = ? AND submission_id = ?'
);
const stmtCountForBadge = db.prepare(
  'SELECT COUNT(*) AS n FROM badge_winners WHERE badge_code = ?'
);
const stmtCodesForSubmission = db.prepare(
  'SELECT badge_code FROM badge_winners WHERE submission_id = ?'
);

/**
 * Is `code` one of the five catalog badges? The single gate every write
 * below runs through, so a stray/forged code can never create a
 * badge_winners row for a badge that does not exist.
 * @param {string} code
 * @returns {boolean}
 */
function isValidCode(code) {
  return PHOTO_BADGE_BY_CODE.has(code);
}

/**
 * Display name for a catalog code, or the code itself if unknown (defensive
 * fallback for a message string — callers should have already checked
 * isValidCode before reaching here in practice).
 * @param {string} code
 * @returns {string}
 */
function badgeName(code) {
  const b = PHOTO_BADGE_BY_CODE.get(code);
  return b ? b.name : code;
}

/**
 * The 5-badge catalog, each carrying its current winner count ("chosen",
 * rendered as "N/5"). Recomputed fresh on every call — cheap COUNT(*) per
 * badge over a handful of rows, not worth caching for a single-event app.
 * @returns {Array<{code: string, name: string, chosen: number}>}
 */
function catalogWithCounts() {
  return PHOTO_BADGES.map((b) => ({ ...b, chosen: stmtCountForBadge.get(b.code).n }));
}

/**
 * Every badge code this submission currently holds a winner record for.
 * @param {number} submissionId
 * @returns {string[]}
 */
function winnerCodesFor(submissionId) {
  return stmtCodesForSubmission.all(submissionId).map((r) => r.badge_code);
}

/**
 * Does this submission already hold badge `code`?
 * @param {string} code
 * @param {number} submissionId
 * @returns {boolean}
 */
function isWinner(code, submissionId) {
  return !!stmtIsWinner.get(code, submissionId);
}

/**
 * Record `submissionId` as one of badge `code`'s winners. Idempotent — a
 * repeat award is a no-op (INSERT OR IGNORE on UNIQUE(badge_code,
 * submission_id)), so double-clicking Award never double-counts a badge's
 * "N/5". Callers must confirm the submission exists first (badge_winners.
 * submission_id REFERENCES submissions(id) with no fallback — awarding
 * against an unknown id throws SQLITE_CONSTRAINT_FOREIGNKEY); the route layer
 * owns that guard, matching every other admin/photos mutation route.
 * @param {string} code
 * @param {number} submissionId
 * @returns {boolean} false only when `code` is not a catalog code (no write).
 */
function award(code, submissionId) {
  if (!isValidCode(code)) return false;
  stmtInsertWinner.run(code, submissionId);
  return true;
}

/**
 * Remove `submissionId` from badge `code`'s winners. No-op if it was not
 * currently a winner of that badge.
 * @param {string} code
 * @param {number} submissionId
 * @returns {boolean} false only when `code` is not a catalog code (no write).
 */
function remove(code, submissionId) {
  if (!isValidCode(code)) return false;
  stmtDeleteWinner.run(code, submissionId);
  return true;
}

module.exports = {
  PHOTO_BADGES,
  isValidCode,
  badgeName,
  catalogWithCounts,
  winnerCodesFor,
  isWinner,
  award,
  remove,
};
