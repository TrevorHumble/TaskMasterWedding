// src/services/task-badges.js
//
// Per-task badge resolution and award writing (issue #483).
//
// FOUNDATION RULE: every task owns exactly one `badges` row of its own
// (type='custom', code='TASK-<id>', task_id set to that task). Distinct
// per task, so a guest completing two plain (un-customized) tasks holds two
// distinct badge_ids and never collides on the existing
// guest_badges UNIQUE(guest_id, badge_id) constraint. An un-customized
// task's row points its art_path at the shared DEFAULT_RIBBON_ART_PATH
// FILE — there is no shared catalog ROW; resolveTaskBadge lazily inserts the
// task's own row the first time it is asked for.
//
// This module is the ONLY task-badge write path:
//   - It never calls scoring.createCustomBadge (which is guarded to refuse
//     any TASK- code — see scoring.js's createCustomBadge).
//   - scoring.js's stmtGrantBadge (the system/auto/metric/transferable path)
//     never touches these rows either; awardTaskBadge below is the only
//     writer of an 'admin'-awarded row that carries points/note/submission_id.

'use strict';

const path = require('path');
const { db } = require('../db');
// NOT required at top level: photos.js requires scoring.js, and scoring.js
// requires THIS module (for TASK_BADGE_CODE_PREFIX) — a top-level
// `require('./photos')` here would complete the cycle mid-load and capture
// photos.js's exports object before it finishes populating (an empty {},
// since photos.js reassigns module.exports at the bottom of the file rather
// than mutating it in place). unlinkUploadedArt below requires('./photos')
// lazily instead, at call time — by then Node's module cache always holds
// the fully-populated real module (photos.js is required well before any
// badge-art request reaches this function, by admin.js/guest.js at app
// boot), and the require() call itself is free after the first real load.

// The shared default-ribbon artwork every un-customized task badge points
// at (issue #483's "shared file, not a shared catalog row"). A single
// constant so the resolver and every caller agree on the exact path — never
// a literal duplicated at more than one call site.
const DEFAULT_RIBBON_ART_PATH = '/badges/default-ribbon.svg';

// Prefix every host-uploaded art_path carries (photos.urlForOriginal's own
// output shape — see admin.js's POST /tasks/:id/badge, which builds artPath
// via urlForOriginal(filename) before calling setTaskBadge). Anything NOT
// under this prefix is a shared static asset (today, only
// DEFAULT_RIBBON_ART_PATH) and must never be unlinked.
const UPLOADS_URL_PREFIX = '/uploads/';

// The code prefix every task badge's derived code carries ('TASK-' + taskId).
// The SINGLE owner of this literal: scoring.js's createCustomBadge imports
// it to refuse a freeform admin code starting with the same prefix (AC8)
// rather than hard-coding a second copy of 'TASK-' that could drift from
// the one taskBadgeCode() actually writes.
const TASK_BADGE_CODE_PREFIX = 'TASK-';

/** @param {number} taskId @returns {string} e.g. 'TASK-42' */
function taskBadgeCode(taskId) {
  return TASK_BADGE_CODE_PREFIX + taskId;
}

const stmtBadgeByTaskId = db.prepare('SELECT * FROM badges WHERE task_id = ?');
const stmtInsertTaskBadge = db.prepare(
  `INSERT INTO badges (code, name, type, threshold, art_path, description, task_id)
   VALUES (?, ?, 'custom', NULL, ?, '', ?)`
);
const stmtUpdateTaskBadge = db.prepare(
  `UPDATE badges SET name = ?, art_path = ? WHERE task_id = ?`
);

/**
 * Resolve task `taskId`'s own badge row, lazily inserting the default row
 * (code 'TASK-<id>', type 'custom', name 'Task Badge', art_path the shared
 * default-ribbon SVG) the first time it is asked for. The lazy insert is
 * idempotent — a second (or concurrent-in-the-same-process) call sees the
 * row the first call just wrote and returns it unchanged, never a second
 * row: the partial UNIQUE INDEX on badges(task_id) (src/db.js
 * ensureBadgeTaskIdColumn) would reject a genuine double-insert outright.
 *
 * @param {number} taskId
 * @returns {object} the badges row (freshly inserted, or already customized)
 */
function resolveTaskBadge(taskId) {
  const existing = stmtBadgeByTaskId.get(taskId);
  if (existing) return existing;

  stmtInsertTaskBadge.run(taskBadgeCode(taskId), 'Task Badge', DEFAULT_RIBBON_ART_PATH, taskId);
  return stmtBadgeByTaskId.get(taskId);
}

/**
 * Look up task `taskId`'s own badge row WITHOUT lazily inserting one —
 * unlike resolveTaskBadge, a task that has never been customized (and never
 * had its admin card rendered, which is what actually triggers the lazy
 * insert) returns undefined here rather than creating a row. Callers that
 * are about to delete the task itself (issue #501's task-delete handler) use
 * this instead of resolveTaskBadge: inserting a fresh badges row for a task
 * id that turns out not to exist would violate the badges.task_id FK
 * (REFERENCES tasks(id), foreign_keys=ON — src/db.js), and there is no
 * reason to insert-then-immediately-cascade-delete a row for a task that IS
 * about to be removed anyway.
 *
 * @param {number} taskId
 * @returns {object|undefined} the badges row, or undefined if none exists yet
 */
function getTaskBadge(taskId) {
  return stmtBadgeByTaskId.get(taskId);
}

/**
 * True when `artPath` points at a host-uploaded file under the /uploads
 * mount, as opposed to a shared static asset (today, only
 * DEFAULT_RIBBON_ART_PATH). The SINGLE owner of "is this badge art eligible
 * for deletion" (issue #501) — both setTaskBadge (below) and admin.js's
 * task-delete handler go through this test rather than each re-deriving the
 * /uploads/ prefix check on their own.
 *
 * @param {string|null|undefined} artPath
 * @returns {boolean}
 */
function isUploadedArtPath(artPath) {
  return typeof artPath === 'string' && artPath.startsWith(UPLOADS_URL_PREFIX);
}

/**
 * Unlink `artPath`'s underlying file from disk IF it is a host-uploaded file
 * (isUploadedArtPath) — a no-op for the shared default ribbon SVG, or for any
 * falsy/non-uploaded path, so this can be called unconditionally without the
 * caller having to check eligibility itself. Derives the bare filename via
 * path.basename before handing it to photos.deleteOriginalFile, which joins
 * a BARE filename onto UPLOADS_DIR with no basename sanitization of its own
 * (see that function's doc comment) — path.basename is what keeps this call
 * safe even if a stored art_path were ever something other than the exact
 * "/uploads/<filename>" shape urlForOriginal produces.
 *
 * @param {string|null|undefined} artPath
 */
function unlinkUploadedArt(artPath) {
  if (!isUploadedArtPath(artPath)) return;
  // Lazy require — see the top-of-file note on why this cannot be a
  // top-level `require('./photos')`.
  const photos = require('./photos');
  photos.deleteOriginalFile(path.basename(artPath));
}

/**
 * Project a raw `badges` row down to the shape a renderer is allowed to
 * see: `{name, art_path}`. This is the SINGLE owner of "what a task badge
 * looks like to a renderer" (issue #486 round 2) — resolveTaskBadge's
 * return value is the full internal row (id, code, type, threshold,
 * description, task_id, ...), and every call site that needs to display a
 * task's badge (the guest task list, the admin task board) must go through
 * this function rather than hand-picking fields off that row itself, so the
 * display contract can only ever be defined in one place.
 *
 * @param {object} badgeRow a row as returned by resolveTaskBadge
 * @returns {{name: string, art_path: string}}
 */
function toTaskBadgeView(badgeRow) {
  return { name: badgeRow.name, art_path: badgeRow.art_path };
}

/**
 * Update task `taskId`'s badge name and/or art, resolving (and lazily
 * inserting) it first so this can be called on a task that has never been
 * customized before. An empty/absent `name` or `artPath` leaves that field
 * unchanged rather than blanking it — the admin form posts only the field(s)
 * it actually collected (e.g. art with no new name, or vice versa).
 *
 * Wrapped in a transaction (same reasoning as photos.js's
 * _setTakenDownAndRecount): the resolve-then-update is two statements on a
 * task that has never been customized before, and better-sqlite3's
 * transaction wrapper is what makes that pair atomic against a mid-write
 * crash rather than relying on there being nothing between them to fail.
 *
 * @param {number} taskId
 * @param {{name?: string, artPath?: string}} params
 * @returns {object} the updated badges row
 */
const setTaskBadge = db.transaction((taskId, { name, artPath } = {}) => {
  const badge = resolveTaskBadge(taskId);
  const nextName = name ? name : badge.name;
  const nextArtPath = artPath ? artPath : badge.art_path;

  // Unlink the PRIOR uploaded art file (issue #501) — but only when a new
  // artPath is actually being set (a name-only submit leaves art_path, and
  // therefore this condition, untouched) AND the prior file differs from the
  // incoming one (re-posting the exact same path is a no-op, not a
  // self-delete of the file the write below is about to store again).
  // unlinkUploadedArt's own isUploadedArtPath guard is what keeps
  // DEFAULT_RIBBON_ART_PATH un-deletable (AC2) without a second check here.
  if (artPath && badge.art_path !== nextArtPath) {
    unlinkUploadedArt(badge.art_path);
  }

  stmtUpdateTaskBadge.run(nextName, nextArtPath, taskId);
  return stmtBadgeByTaskId.get(taskId);
});

// ---------------------------------------------------------------------------
// Award write path.
// ---------------------------------------------------------------------------

const stmtSubmissionForAward = db.prepare(
  'SELECT guest_id, taken_down FROM submissions WHERE id = ?'
);
const stmtInsertAward = db.prepare(
  `INSERT OR IGNORE INTO guest_badges (guest_id, badge_id, awarded_by, points, note, submission_id)
   VALUES (?, ?, 'admin', ?, ?, ?)`
);
const stmtDeleteAwardBySubmission = db.prepare(
  'DELETE FROM guest_badges WHERE badge_id = ? AND submission_id = ?'
);

/**
 * Award task `taskId`'s badge to whoever took submission `submissionId`,
 * carrying `points` and an optional `note` on the award row (guest_badges),
 * not on the badge catalog row — the same task badge can be awarded to
 * different photos with different points/notes (AC4).
 *
 * The grantee is DERIVED from the submission, and the submission must be
 * currently visible (taken_down = 0); a missing or taken-down submission is
 * refused with no row written (returns null) rather than awarding a badge on
 * behalf of a photo the guest can no longer see. `points` is coerced with
 * the same Math.trunc(Number(...)) shape scoring.addBonusPoints uses for its
 * delta, so a non-numeric/NaN input becomes 0 instead of writing NaN into
 * SQLite (SQLite would otherwise happily store the string "NaN") — then
 * floored at 0, mirroring the non-negative invariant the existing per-photo
 * bonus (submissions.photo_bonus) enforces at its own route layer: an
 * award's points is a single Task Master judgment, never a debit.
 *
 * INSERT OR IGNORE on the existing guest_badges UNIQUE(guest_id, badge_id)
 * makes a repeat award to the SAME guest+badge a no-op, matching
 * scoring.js's stmtGrantBadge behavior for every other award path.
 *
 * Wrapped in a transaction: resolveTaskBadge may itself insert the task's
 * first-ever badge row, so an award against a never-customized task is two
 * writes (the lazy badge insert, then the award insert) that must both land
 * or neither should — same reasoning as setTaskBadge above.
 *
 * @param {number} taskId
 * @param {number} submissionId
 * @param {{points: number, note?: string}} params
 * @returns {object|null} the awarded badges row, or null if refused
 */
const awardTaskBadge = db.transaction((taskId, submissionId, { points, note } = {}) => {
  const submission = stmtSubmissionForAward.get(submissionId);
  if (!submission || submission.taken_down) {
    return null;
  }
  const badge = resolveTaskBadge(taskId);
  const amount = Math.max(0, Math.trunc(Number(points)) || 0);
  stmtInsertAward.run(submission.guest_id, badge.id, amount, note || null, submissionId);
  return badge;
});

/**
 * Remove the award task `taskId`'s badge made against submission
 * `submissionId`. No-op if the task has no badge row yet, or no such award
 * exists.
 *
 * @param {number} taskId
 * @param {number} submissionId
 */
function removeTaskAward(taskId, submissionId) {
  const badge = stmtBadgeByTaskId.get(taskId);
  if (!badge) return;
  stmtDeleteAwardBySubmission.run(badge.id, submissionId);
}

module.exports = {
  DEFAULT_RIBBON_ART_PATH,
  TASK_BADGE_CODE_PREFIX,
  taskBadgeCode,
  resolveTaskBadge,
  getTaskBadge,
  toTaskBadgeView,
  setTaskBadge,
  awardTaskBadge,
  removeTaskAward,
  // orphaned-art cleanup (issue #501) — exported for admin.js's task-delete
  // handler and for direct unit testing.
  isUploadedArtPath,
  unlinkUploadedArt,
};
