// src/services/submissions.js
//
// The submit-or-replace sequence for "a guest turns in a photo for a task".
//
// submitPhoto() is the one function that knows this whole sequence: validate
// the task is live, build the thumbnail, normalize the caption, upsert the
// submissions row (UNIQUE(guest_id, task_id) means at most one row per task,
// so a second submission REPLACES the first rather than erroring), clean up
// superseded files, and recompute the guest's auto-badges. Before this module
// existed, that ordering knowledge was inlined in the HTTP handler
// (src/routes/guest.js); here it is callable directly with a plain file
// descriptor, so a test — or a future non-HTTP caller — never has to drive a
// multipart request just to record a submission.
//
// submitPhoto() takes an already-parsed file descriptor `{ filename, path }`
// (multer's shape after disk storage runs) and returns a plain status object.
// It never touches req/res/Express/multer — parsing the upload and validating
// its size/type stays the route's job, same as before this module existed.
//
// better-sqlite3 is fully synchronous: prepare(...).get/.all/.run, no async.
// makeThumb (src/services/photos.js) is the one async step in the sequence.

'use strict';

const { db } = require('../db');
const photos = require('./photos');
const scoring = require('./scoring');

// ---------------------------------------------------------------------------
// Prepared statements (compiled once, reused on every call).
// ---------------------------------------------------------------------------

const stmtActiveTask = db.prepare('SELECT id, is_active FROM tasks WHERE id = ?');

const stmtExistingSubmission = db.prepare(
  'SELECT id, photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?'
);

const stmtReplaceSubmission = db.prepare(
  `UPDATE submissions
      SET photo_path = ?, thumb_path = ?, caption = ?, taken_down = 0,
          created_at = datetime('now')
    WHERE id = ?`
);

const stmtInsertSubmission = db.prepare(
  `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down)
   VALUES (?, ?, ?, ?, ?, 0)`
);

/**
 * Trim and cap a caption to the stored column's limit. A missing or non-string
 * caption (the field is optional in the upload form) becomes '' rather than
 * throwing, mirroring the defensive read the route used to do inline.
 * @param {*} caption - req.body.caption, or any caller-supplied value
 * @returns {string} the value to store, always a string of length <= 500
 */
function normalizeCaption(caption) {
  return typeof caption === 'string' ? caption.trim().slice(0, 500) : '';
}

/**
 * Record a guest's photo submission for a task, replacing any prior
 * submission for the same (guestId, taskId) pair.
 *
 * Sequence (each step's failure mode is folded into the returned status so
 * the caller never has to catch — see the read-me at the top of this file):
 *   1. The task must exist and be active, or the passed-in original file is
 *      deleted and the call returns 'task_inactive'. Checking this here (not
 *      before the file is written) is what closes the orphan-file leak the
 *      route used to have: multer writes the original to disk BEFORE this
 *      function is ever called, so this is the first point that knows enough
 *      to say the upload was pointless and clean it up.
 *   2. A thumbnail is generated from the original. If that throws, the
 *      original is deleted and the call returns 'thumb_failed'.
 *   3. The caption is normalized (see normalizeCaption).
 *   4. An existing (guestId, taskId) row is replaced in place — preserving
 *      its id and un-hiding it (taken_down = 0) — or a new row is inserted.
 *      Old files are deleted only once the DB write has committed, and only
 *      when their filename actually changed; deletion failures are logged
 *      and ignored, because a leftover file is harmless but losing the new
 *      submission is not.
 *   5. Auto-badges are recomputed for the guest. A failure here is logged and
 *      swallowed — the submission the guest just made must never be lost
 *      because a badge recount had a problem.
 *
 * @param {object} params
 * @param {number} params.guestId
 * @param {number} params.taskId
 * @param {{filename: string, path: string}} params.file - multer's disk-storage
 *        descriptor: filename is the stored original's relative filename,
 *        path is its absolute path on disk (what makeThumb reads from).
 * @param {*} params.caption - raw caption input; normalized internally.
 * @returns {Promise<{status: 'created'|'replaced'|'task_inactive'|'thumb_failed', submissionId?: number}>}
 */
async function submitPhoto({ guestId, taskId, file, caption }) {
  const task = stmtActiveTask.get(taskId);
  if (!task || task.is_active !== 1) {
    photos.deleteOriginalFile(file.filename);
    return { status: 'task_inactive' };
  }

  const photoPath = file.filename;
  let thumbPath;
  try {
    thumbPath = await photos.makeThumb(file.path);
  } catch (_err) {
    photos.deleteOriginalFile(photoPath);
    return { status: 'thumb_failed' };
  }

  const cap = normalizeCaption(caption);

  const existing = stmtExistingSubmission.get(guestId, taskId);

  let status;
  let submissionId;
  if (existing) {
    stmtReplaceSubmission.run(photoPath, thumbPath, cap, existing.id);
    submissionId = existing.id;
    status = 'replaced';

    // Delete the superseded files only after the DB write committed, and only
    // when the filename actually changed. Failures are logged and ignored: a
    // leftover file on disk is harmless, but this must never undo the write
    // above.
    try {
      if (existing.photo_path && existing.photo_path !== photoPath) {
        photos.deleteOriginalFile(existing.photo_path);
      }
      if (existing.thumb_path && existing.thumb_path !== thumbPath) {
        photos.deleteThumbFile(existing.thumb_path);
      }
    } catch (err) {
      console.error('superseded-file cleanup failed:', err);
    }
  } else {
    const info = stmtInsertSubmission.run(guestId, taskId, photoPath, thumbPath, cap);
    submissionId = info.lastInsertRowid;
    status = 'created';
  }

  // Recompute points + auto badges now that completion may have changed. A
  // failure here must not lose the photo just recorded above, so it is
  // logged and swallowed rather than propagated.
  try {
    scoring.recomputeAutoBadges(guestId);
  } catch (err) {
    console.error('recomputeAutoBadges failed:', err);
  }

  return { status, submissionId };
}

module.exports = {
  submitPhoto,
};
