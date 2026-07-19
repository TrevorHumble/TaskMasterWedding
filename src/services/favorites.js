// src/services/favorites.js
//
// Host-scoped photo favorites for the admin photos screen (issue #259).
//
// This app has exactly one shared admin login (no per-admin identity —
// requireAdmin checks a single signed cookie, src/middleware/session.js), so
// a "favorite" is one shared flag per photo, not a per-admin-user record.
// Presence of a row in admin_favorites (src/db.js) IS the favorite; there is
// no boolean column to keep in sync with row existence.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.

'use strict';

const { db } = require('../db');

const stmtInsert = db.prepare('INSERT OR IGNORE INTO admin_favorites (submission_id) VALUES (?)');
const stmtDelete = db.prepare('DELETE FROM admin_favorites WHERE submission_id = ?');
const stmtIsFavorite = db.prepare('SELECT 1 FROM admin_favorites WHERE submission_id = ?');
const stmtAllIds = db.prepare('SELECT submission_id FROM admin_favorites');

/**
 * Is this submission currently favorited?
 * @param {number} submissionId
 * @returns {boolean}
 */
function isFavorite(submissionId) {
  return !!stmtIsFavorite.get(submissionId);
}

/**
 * Every currently-favorited submission id, as a Set for O(1) membership
 * checks while annotating a page of photo rows (GET /admin/photos reads this
 * once per request rather than querying per-row).
 * @returns {Set<number>}
 */
function favoriteIdSet() {
  return new Set(stmtAllIds.all().map((r) => r.submission_id));
}

/**
 * Flip the favorite flag for a submission.
 *
 * Callers must confirm the submission exists first (admin_favorites.submission_id
 * REFERENCES submissions(id) with no ON DELETE SET NULL fallback — inserting
 * against an unknown id throws SQLITE_CONSTRAINT_FOREIGNKEY): the route layer
 * owns that "Submission not found." guard, matching every other admin/photos
 * mutation route (src/routes/admin.js).
 *
 * @param {number} submissionId
 * @returns {boolean} the NEW state — true if now favorited, false if now
 *   unfavorited.
 */
function toggleFavorite(submissionId) {
  if (isFavorite(submissionId)) {
    stmtDelete.run(submissionId);
    return false;
  }
  stmtInsert.run(submissionId);
  return true;
}

module.exports = { isFavorite, favoriteIdSet, toggleFavorite };
