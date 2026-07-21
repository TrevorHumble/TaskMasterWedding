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

const { db, getEventConfig } = require('../db');
const photos = require('./photos');
const scoring = require('./scoring');
// tasks.js is the ONE active-task owner (issue #727) — isTaskLive(task)
// consumes it here instead of a hand-written is_active/special_mode check.
// isSealed(task, todayIso) is the ONE one-day-only-challenge seal owner
// (issue #753) — this is the only place a submit gate can live, since the
// route (src/routes/guest.js) never loads the task itself.
const tasks = require('./tasks');
// eventLocalDateString is the ONE "what day is it for the event" owner
// (issue #753) — always the event's configured timezone, never server UTC.
const eventDays = require('./event-days');

// ---------------------------------------------------------------------------
// Prepared statements (compiled once, reused on every call).
// ---------------------------------------------------------------------------

// special_date/special_bonus (issue #753) are read alongside special_mode so
// a single row load serves both the live/seal gates AND the on-day bonus
// decision below — without special_date the seal predicate would read
// `undefined` and report "not sealed" for every one-day-only task, and
// without special_bonus the banking write would bind `undefined` into
// submissions.bonus_amount, a NOT NULL column, throwing inside submitPhoto.
const stmtActiveTask = db.prepare(
  'SELECT id, special_mode, special_date, special_bonus FROM tasks WHERE id = ?'
);

// bonus_amount (issue #753) is read alongside the existing three columns so
// the replace branch below can tell "already banked a bonus on this row"
// (bonus_amount !== 0) apart from "never banked one" (=== 0) WITHOUT a
// second query — a strict `=== 0` check against a SELECT that omitted this
// column would read `undefined` and never bank on a replace (undefined !==
// 0 is always true, but undefined is also never a safe value to reason
// "already banked" from).
const stmtExistingSubmission = db.prepare(
  'SELECT id, photo_path, thumb_path, taken_down, bonus_amount FROM submissions WHERE guest_id = ? AND task_id = ?'
);

// Sticky-takedown replace (issue #190): deliberately does NOT touch
// taken_down. Forcing taken_down = 0 here (as this statement used to) is
// exactly the bug #190 fixed — it let any resubmit silently reverse an
// admin's takedown. Whatever taken_down was before the replace, it still is
// after; only resubmitted (set by stmtMarkResubmitted below, conditionally)
// records that a new photo is waiting behind a still-hidden row.
const stmtReplaceSubmission = db.prepare(
  `UPDATE submissions
      SET photo_path = ?, thumb_path = ?, caption = ?,
          created_at = datetime('now')
    WHERE id = ?`
);

// Flip resubmitted on only when the replace landed on an already-taken-down
// row (issue #190 AC1/AC3). Never flips it off here — restoreSubmission
// (src/services/photos.js) is the single place that clears it, in the same
// transaction as the taken_down flag flip back to 0.
const stmtMarkResubmitted = db.prepare(`UPDATE submissions SET resubmitted = 1 WHERE id = ?`);

// Bank the one-day-only on-day bonus (issue #753) onto an EXISTING row —
// the replace branch's counterpart to stmtInsertSubmission's own
// bonus_amount/bonus_reason columns below. Deliberately its own statement
// rather than folded into stmtReplaceSubmission: it must run ONLY when the
// row has not already banked a bonus (see the `bonus_amount === 0` guard at
// the call site) so a resubmit on a later, off-day date can never overwrite
// an already-banked amount back to 0 — stmtReplaceSubmission itself never
// touches bonus_amount/bonus_reason at all, for exactly that reason.
const stmtBankBonus = db.prepare(
  `UPDATE submissions SET bonus_amount = ?, bonus_reason = ? WHERE id = ?`
);

// Replace + (conditional) bank + (conditional) resubmitted-mark as ONE
// atomic unit (issue #753 review fix). Before this, stmtReplaceSubmission
// ran and committed the new photo_path on its own, uncoordinated with
// stmtBankBonus a few lines later -- if stmtBankBonus threw (e.g. a legacy
// row whose special_bonus was NULL despite its special_date being set,
// binding NULL into bonus_amount's NOT NULL column), the guest was told the
// save failed while the DB already held the new photo, and the superseded-
// file cleanup below (which runs only after this whole block) never ran, so
// the OLD file also leaked. Wrapping all three writes in one
// db.transaction() means a throw from any of them rolls the DB back to the
// old photo_path/thumb_path/bonus_amount/resubmitted values, so "told
// failed" and "the database row is unchanged" stay consistent with each
// other. That guarantee is DB-only, though: the NEW original + thumbnail
// were already written to disk (by multer / makeThumb) before this
// transaction ever runs, and a SQL rollback has no way to touch them -- the
// call site below is responsible for deleting THOSE two files on a throw
// from here, so a rolled-back DB and a pair of leaked orphan files can never
// happen together. better-sqlite3 transactions are synchronous and nest
// fine inside the async submitPhoto function below -- nothing here awaits.
const replaceAndBank = db.transaction((photoPath, thumbPath, cap, existing, bankArgs) => {
  stmtReplaceSubmission.run(photoPath, thumbPath, cap, existing.id);
  if (bankArgs) {
    stmtBankBonus.run(bankArgs.bonusAmount, bankArgs.bonusReason, existing.id);
  }
  if (existing.taken_down === 1) {
    stmtMarkResubmitted.run(existing.id);
  }
});

const stmtInsertSubmission = db.prepare(
  `INSERT INTO submissions
     (guest_id, task_id, photo_path, thumb_path, caption, taken_down, bonus_amount, bonus_reason)
   VALUES (?, ?, ?, ?, ?, 0, ?, ?)`
);

// A "memory" row (issue #247): task_id is explicitly NULL, marking it as not
// tied to any task. UNIQUE(guest_id, task_id) does not block multiple memory
// rows per guest — SQLite treats every NULL as distinct under UNIQUE.
const stmtInsertMemory = db.prepare(
  `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down)
   VALUES (?, NULL, ?, ?, ?, 0)`
);

// The single owner of the caption length cap. Exported (issue #387) so the
// edit-caption view's textarea maxlength reads THIS value instead of a
// hand-copied literal that could drift from the server rule — the same
// single-source shape COMMENT_MAX_LENGTH uses for the comment composer.
const CAPTION_MAX_LENGTH = 500;

// The bonus_reason literal this issue's one-day-only banking writes (issue
// #753's design: "#649 and #650 write their own literals into this same
// shared column, so the vocabulary starts here"). Exported so a future
// reader (a moderation view, a test) can compare against THIS constant
// rather than a hand-copied 'oneday' string that could drift from what
// submitPhoto actually writes.
const BONUS_REASON_ONEDAY = 'oneday';

/**
 * Trim and cap a caption to the stored column's limit. A missing or non-string
 * caption (the field is optional in the upload form) becomes '' rather than
 * throwing, mirroring the defensive read the route used to do inline.
 * @param {*} caption - req.body.caption, or any caller-supplied value
 * @returns {string} the value to store, always a string of length <= CAPTION_MAX_LENGTH
 */
function normalizeCaption(caption) {
  return typeof caption === 'string' ? caption.trim().slice(0, CAPTION_MAX_LENGTH) : '';
}

/**
 * Record a guest's photo submission for a task, replacing any prior
 * submission for the same (guestId, taskId) pair.
 *
 * Sequence (each step's failure mode is folded into the returned status so
 * the caller never has to catch — see the read-me at the top of this file):
 *   1. The task must exist, be active, and (issue #753) not be a sealed
 *      one-day-only challenge for the event-local "today" — otherwise the
 *      passed-in original file is deleted and the call returns
 *      'task_inactive', exactly the same outcome as a hidden task, so a
 *      guessed task URL cannot bank an early submission before its date.
 *      Checking this here (not before the file is written) is what closes
 *      the orphan-file leak the route used to have: multer writes the
 *      original to disk BEFORE this function is ever called, so this is the
 *      first point that knows enough to say the upload was pointless and
 *      clean it up.
 *   2. A thumbnail is generated from the original. If that throws, the
 *      original is deleted and the call returns 'thumb_failed'.
 *   3. The caption is normalized (see normalizeCaption).
 *   4. An existing (guestId, taskId) row is replaced in place — preserving
 *      its id AND its current taken_down value (issue #190: a host takedown
 *      is sticky across a resubmit; it no longer self-restores) — or a new
 *      row is inserted. When the replaced row was taken_down, resubmitted is
 *      also set so /admin/photos can flag it for a moderation decision.
 *      Old files are deleted only once the DB write has committed, and only
 *      when their filename actually changed; deletion failures are logged
 *      and ignored, because a leftover file is harmless but losing the new
 *      submission is not.
 *
 *      Issue #753's on-day bonus is BANKED here, never derived at read time
 *      (a replace resets created_at, so a derived bonus would silently
 *      vanish the moment a guest swapped in a better photo the next day): a
 *      brand-new row banks `task.special_bonus` when the task's
 *      `special_date` equals today, else 0. A REPLACED row banks the same
 *      way, but ONLY when it has not already banked a bonus
 *      (`existing.bonus_amount === 0`) — a resubmit on a later, off-day date
 *      must never overwrite (or zero out) a bonus already banked on the day
 *      itself.
 *   5. Auto-badges are recomputed for the guest. A failure here is logged and
 *      swallowed — the submission the guest just made must never be lost
 *      because a badge recount had a problem.
 *
 * After the recompute (successful or swallowed), the guest's held-badge set is
 * snapshotted again and diffed against the snapshot taken immediately before
 * the recompute (issue #255): `newBadgeIds` is the set of badge codes present
 * after but not before, and `pointsTotal` is the guest's fresh points total.
 * A swallowed recompute failure leaves the after-snapshot identical to the
 * before-snapshot, so `newBadgeIds` comes out empty — never a throw. Everything
 * from the submission upsert through this diff runs with no `await` in
 * between, so on Node's single-threaded event loop no other request's JS can
 * interleave mid-span; a concurrent submit by the same guest cannot corrupt
 * this diff (the only `await` in this function, makeThumb, already completed
 * by this point).
 *
 * @param {object} params
 * @param {number} params.guestId
 * @param {number} params.taskId
 * @param {{filename: string, path: string}} params.file - multer's disk-storage
 *        descriptor: filename is the stored original's relative filename,
 *        path is its absolute path on disk (what makeThumb reads from).
 * @param {*} params.caption - raw caption input; normalized internally.
 * @returns {Promise<{status: 'created'|'replaced'|'replaced_hidden'|'task_inactive'|'thumb_failed', submissionId?: number, newBadgeIds?: string[], pointsTotal?: number}>}
 */
async function submitPhoto({ guestId, taskId, file, caption }) {
  const task = stmtActiveTask.get(taskId);
  if (!task || !tasks.isTaskLive(task)) {
    photos.deleteOriginalFile(file.filename);
    return { status: 'task_inactive' };
  }

  // Event-local "today" (issue #753) — never server UTC. Computed once per
  // call and reused below for both the seal check and the on-day bonus
  // decision, so the two can never disagree about what day it is.
  const todayIso = eventDays.eventLocalDateString(getEventConfig().timezone);
  if (tasks.isSealed(task, todayIso)) {
    // Sealed one-day-only challenge: identical outcome to a hidden task — a
    // guessed URL cannot bank an early submission before its date.
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

  // The on-day bonus (issue #753): the task's special_bonus banks exactly
  // when its special_date equals today. An ordinary task (special_date NULL)
  // never matches, so isOnDay is always false for it.
  const isOnDay = task.special_date != null && task.special_date === todayIso;

  const existing = stmtExistingSubmission.get(guestId, taskId);

  let status;
  let submissionId;
  if (existing) {
    submissionId = existing.id;

    // Coalesce special_bonus (issue #753 review fix): the schema's
    // chk_special_pairing CHECK stops a NEW row from ever pairing
    // special_date with a NULL special_bonus, but it cannot retroactively
    // fix a row written before that constraint existed, or one edited by
    // hand straight in the DB file. Binding `?? 0` here means that
    // impossible-in-theory shape still can't throw SQLITE_CONSTRAINT_NOTNULL
    // into submitPhoto and turn into "photo couldn't save" for the guest.
    //
    // bonusReason is written ONLY when the coalesced amount is actually > 0
    // (review fix): on that same legacy-row shape, special_bonus coalesces
    // to 0, and #649/#650 read bonus_reason by literal to decide whether a
    // bonus rule paid out -- a reason of 'oneday' sitting next to amount 0
    // would tell them a rule paid when nothing was actually banked.
    const coalescedBonus =
      isOnDay && existing.bonus_amount === 0 ? (task.special_bonus ?? 0) : null;
    const bankArgs =
      coalescedBonus !== null
        ? {
            bonusAmount: coalescedBonus,
            bonusReason: coalescedBonus > 0 ? BONUS_REASON_ONEDAY : null,
          }
        : null;

    // One atomic write (see replaceAndBank's own comment above): the photo
    // swap, the bonus bank, and the resubmitted-mark either all land or none
    // do, so a throw here can never leave the guest told "failed" while the
    // DB already holds the new photo. The DB rollback does not reach disk,
    // though: photoPath/thumbPath were already written by multer/makeThumb
    // before this call, so a throw here must also delete THOSE two (not
    // existing.photo_path/thumb_path -- the superseded-file cleanup below
    // still owns cleaning up the OLD files once a replace actually commits)
    // before rethrowing, or a failed replace would leak the new upload to
    // DATA_DIR forever with nothing left pointing at it.
    try {
      replaceAndBank(photoPath, thumbPath, cap, existing, bankArgs);
    } catch (err) {
      photos.deleteOriginalFile(photoPath);
      photos.deleteThumbFile(thumbPath);
      throw err;
    }

    if (existing.taken_down === 1) {
      // Sticky takedown (issue #190): the row stays hidden. Mark it
      // resubmitted so the host sees a decision waiting on /admin/photos.
      status = 'replaced_hidden';
    } else {
      status = 'replaced';
    }

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
    // Coalesce special_bonus the same way the replace branch above does —
    // see that branch's comment (issue #753 review fix).
    const bonusAmount = isOnDay ? (task.special_bonus ?? 0) : 0;
    const bonusReason = isOnDay ? BONUS_REASON_ONEDAY : null;
    const info = stmtInsertSubmission.run(
      guestId,
      taskId,
      photoPath,
      thumbPath,
      cap,
      bonusAmount,
      bonusReason
    );
    submissionId = info.lastInsertRowid;
    status = 'created';
  }

  // Snapshot the guest's held-badge codes immediately before the recompute
  // (issue #255) so the diff below can tell which badges this submission
  // newly earned, as opposed to badges the guest already held.
  const beforeBadgeCodes = new Set(scoring.getGuestBadges(guestId).map((b) => b.code));

  // Recompute points + badges now that completion may have changed: one seam
  // that runs the per-guest auto/metric pass and the global transferable pass
  // in order (issue #80 — a new submission can both grant this guest a metric
  // badge AND change who holds a registered transferable one). A failure
  // here must not lose the photo just recorded above, so it is logged and
  // swallowed rather than propagated.
  try {
    scoring.recomputeAfterSubmissionChange(guestId);
  } catch (err) {
    console.error('recomputeAfterSubmissionChange failed:', err);
  }

  // Diff against the before-snapshot. When the recompute above threw and was
  // swallowed, the guest's badge set never changed, so this naturally comes
  // out empty rather than throwing.
  const newBadgeIds = scoring
    .getGuestBadges(guestId)
    .map((b) => b.code)
    .filter((code) => !beforeBadgeCodes.has(code));

  // Points are driven by completed-task count / bonuses, not by the badges
  // table, so this total is correct regardless of whether the recompute above
  // succeeded.
  const pointsTotal = scoring.getPoints(guestId);

  return { status, submissionId, newBadgeIds, pointsTotal };
}

/**
 * Record a batch of "memory" photos for a guest — visible submissions with
 * task_id = NULL (issue #247): photos that don't correspond to any task, so a
 * guest's camera roll can still end up in the shared gallery.
 *
 * Unlike submitPhoto(), this:
 *   - never replaces an existing row (a guest may share any number of
 *     memories; there is no (guestId, NULL) row to collide with — SQLite's
 *     UNIQUE(guest_id, task_id) treats every NULL as distinct);
 *   - never calls scoring.recomputeAfterSubmissionChange — memories are
 *     deliberately excluded from points and system-computed badges (the
 *     "40 memory uploads shouldn't flood the leaderboard" rule),
 *     so there is nothing here for a recompute to change.
 *
 * Each file gets the same photos.makeThumb() step submitPhoto uses. Thumbnail
 * generation is async (sharp) and must complete before the row insert, so it
 * runs first, file by file; only the (synchronous) inserts run inside one
 * db.transaction. A file whose thumbnail fails (e.g. a corrupt upload that
 * slipped past fileFilter — same failure mode submitPhoto's 'thumb_failed'
 * status covers) is skipped: its original is deleted from disk and it
 * contributes no row, but the rest of the batch still proceeds — one bad file
 * among ten should not cost the guest the other nine.
 *
 * @param {object} params
 * @param {number} params.guestId
 * @param {{filename: string, path: string}[]} params.files - multer disk-storage
 *        descriptors (photos.uploadMemoryBatch's req.files).
 * @param {*} params.caption - raw caption input; normalized and applied to
 *        every photo in the batch (the form has one caption field, not
 *        per-photo captions).
 * @returns {Promise<{status: 'created', submissionIds: number[]}>}
 */
async function submitMemoryBatch({ guestId, files, caption }) {
  const cap = normalizeCaption(caption);

  const prepared = [];
  for (const file of files) {
    let thumbPath;
    try {
      thumbPath = await photos.makeThumb(file.path);
    } catch (_err) {
      photos.deleteOriginalFile(file.filename);
      continue; // skip this one file; the rest of the batch still proceeds
    }
    prepared.push({ photoPath: file.filename, thumbPath });
  }

  const submissionIds = [];
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      const info = stmtInsertMemory.run(guestId, row.photoPath, row.thumbPath, cap);
      submissionIds.push(info.lastInsertRowid);
    }
  });
  insertMany(prepared);

  return { status: 'created', submissionIds };
}

module.exports = {
  submitPhoto,
  submitMemoryBatch,
  normalizeCaption,
  CAPTION_MAX_LENGTH,
  BONUS_REASON_ONEDAY,
};
