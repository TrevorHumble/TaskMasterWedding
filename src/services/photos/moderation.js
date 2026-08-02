// src/services/photos/moderation.js
// Takedown/restore/hardDelete moderation and the static-serving takedown
// guards (issue #979 split). This file is the SINGLE WRITER of taken_down —
// hideSubmission and restoreSubmission are the only functions allowed to
// flip the flag for a takedown/restore — and owns the "is this row hidden by
// its owning guest" attribution predicates (#886) plus the two guard
// middlewares that keep a taken-down file from being served.
'use strict';

const fs = require('fs');
const path = require('path');

const { db } = require('../../db');
const scoring = require('../scoring');
const { isAdminRequest } = require('../../middleware/session');
const { absOriginalPath, absThumbPath } = require('./paths');
const { ORIGINAL_RE, THUMB_RE } = require('./naming');

// ---------------------------------------------------------------------------
// Takedown / restore. These flip a flag; they do NOT touch files on disk.
// taken_down=1 hides a submission from gallery, profiles AND scoring (all of
// those queries filter on taken_down=0), while the file stays available for export.
//
// hideSubmission and restoreSubmission each do the flip and the badge
// recount inside ONE db.transaction (see the file header for the
// single-writer rule). better-sqlite3 nests transactions as SAVEPOINTs, so
// calling scoring.recomputeAfterSubmissionChange (itself a db.transaction)
// from inside this one is safe. Folding both writes into one transaction is what makes it
// impossible for a caller to flip the flag without the recount running too —
// no route may run its own `UPDATE submissions SET taken_down` for moderation.
// ---------------------------------------------------------------------------

const _getSubmissionGuest = db.prepare('SELECT guest_id FROM submissions WHERE id = ?');
const _getTakenDown = db.prepare('SELECT taken_down FROM submissions WHERE id = ?');

/**
 * Whether a submission is currently taken down, or undefined if no such
 * submission exists. The one reader of taken_down's raw 1/0 encoding outside
 * the flip transaction (issue #783) — a caller that needs to know whether an
 * upcoming takedown/restore call would be a no-op asks here instead of
 * re-deriving the column's encoding with its own SELECT.
 * @param {number} submissionId
 * @returns {boolean|undefined}
 */
function isTakenDown(submissionId) {
  const row = _getTakenDown.get(submissionId);
  return row ? row.taken_down === 1 : undefined;
}
// taken_down_by (issue #886) is written in the SAME statement as taken_down,
// never a separate UPDATE — see the file-level "single writer" comment above:
// the two columns flip together, in the same transaction, or not at all.
const _setTakenDown = db.prepare(
  'UPDATE submissions SET taken_down = ?, taken_down_by = ? WHERE id = ?'
);
// Cleared only on restore (issue #190) — see restoreSubmission below. hide
// leaves resubmitted exactly as it was: a takedown does not, by itself, say
// anything about whether a resubmit is pending.
const _clearResubmitted = db.prepare('UPDATE submissions SET resubmitted = 0 WHERE id = ?');

// The only two legal explicit values for hideSubmission's `by` argument
// (issue #886's "Attribution convention"). NULL is a legitimate STORED value
// (a legacy or unattributed row) but is never a legal ARGUMENT here — a
// caller that wants "no attribution" has nothing to ask for, since every
// call site knows which actor it is.
const VALID_TAKEN_DOWN_BY = new Set(['admin', 'guest']);

// The SINGLE owner of the Attribution convention's "is this row hidden by
// the guest who owns it" predicate (#886). This codebase already had this
// exact duplicated-visibility-rule problem once — see src/services/feed.js's
// own file comment on why
// taken_down itself has exactly one owner — so the fix here is the same
// move: one function, consumed everywhere the question is asked, rather than
// independent copies of `taken_down === 1 && taken_down_by === 'guest'`
// drifting apart. Deliberately NOT enumerated by caller here (or in
// isStickyTakedown below): a per-file roster goes stale the moment a new
// consumer is added or an existing one changes shape — what this comment
// owns is what the predicate MEANS, not who currently calls it.
//
// Written in the SAME direction the Attribution convention requires
// elsewhere (see hideSubmission's own doc comment): TRUE only when
// taken_down_by is explicitly 'guest'. A NULL or 'admin' attribution reads
// false here — sticky, per #190 — even though a NULL row is also hidden.
// isStickyTakedown below negates this (AND still checks taken_down itself —
// "not hidden by the guest" alone is not "sticky" for a currently-visible
// row).
// @param {{taken_down: 0|1, taken_down_by: 'admin'|'guest'|null}} row
// @returns {boolean}
function hiddenByOwningGuest(row) {
  return row.taken_down === 1 && row.taken_down_by === 'guest';
}

// The composed sticky-takedown predicate the Attribution convention reduces
// to: a row that is currently taken down AND was not hidden by the owning
// guest's own delete. Composes hiddenByOwningGuest above rather than letting
// a caller re-type the conjunction — a duplicated
// `taken_down === 1 && !hiddenByOwningGuest(row)` expression hand-typed
// independently at more than one call site (#886): a third attribution
// value added later that updates only one site would silently let a
// guest launder a non-guest takedown into
// their own, reopening the hole AC4 exists to close. Not enumerated by
// caller here either, for the same reason hiddenByOwningGuest's own comment
// gives above.
// @param {{taken_down: 0|1, taken_down_by: 'admin'|'guest'|null}} row
// @returns {boolean}
function isStickyTakedown(row) {
  return row.taken_down === 1 && !hiddenByOwningGuest(row);
}

/**
 * Flip a submission's taken_down flag (and taken_down_by attribution) and
 * recompute the owning guest's auto-badges, atomically. Returns the guest_id
 * so callers can report success without a second lookup; returns undefined
 * if no such submission exists (so callers can guard on that the same way
 * they guarded a raw UPDATE before).
 * @param {number} submissionId
 * @param {0|1} takenDown
 * @param {'admin'|'guest'|null} takenDownBy - the value taken_down_by is set
 *        to in the same write as takenDown. null on restore (visible rows
 *        carry no attribution).
 * @param {boolean} clearResubmitted - true only for restore (issue #190): a
 *        restored row is no longer "resubmitted behind a takedown", so the
 *        flag clears in the same transaction as the taken_down flip.
 * @returns {number|undefined} the submission's guest_id, or undefined if not found.
 */
const _setTakenDownAndRecount = db.transaction(
  (submissionId, takenDown, takenDownBy, clearResubmitted) => {
    const row = _getSubmissionGuest.get(submissionId);
    if (!row) return undefined;
    // Snapshot the crowd-favorite placing set BEFORE the flag flip (issue
    // #625 AC7): a takedown/restore can move which guests place (a taken-down
    // photo's likes stop counting; a restore brings them back), and
    // recordCrowdFavoriteChanges below diffs per GUEST (entry/exit, issue
    // #895) — bounded to the guests whose placing state this one flip moved.
    const beforeCrowd = scoring.crowdFavorites();
    _setTakenDown.run(takenDown, takenDownBy, submissionId);
    if (clearResubmitted) {
      _clearResubmitted.run(submissionId);
    }
    // One recompute seam runs the per-guest auto/metric pass and the global
    // transferable pass in order (issue #80) — a takedown/restore can change
    // who holds a registered transferable badge, not just this guest's own
    // metric badges. The seam is itself a db.transaction, and better-sqlite3
    // nests transaction functions via SAVEPOINTs, so calling it from inside
    // this outer transaction is safe.
    scoring.recomputeAfterSubmissionChange(row.guest_id);
    // Emit the crowd-favorite recap diff (issue #625 AC7, per-guest since
    // #895) — after the flag flip so it sees the CURRENT (post-mutation)
    // placing set.
    scoring.recordCrowdFavoriteChanges(beforeCrowd);
    return row.guest_id;
  }
);

/**
 * Hide a submission (photo takedown). Keeps the file on disk for export.
 * Recomputes the guest's auto-badges in the same transaction as the flag flip,
 * so a dropped visible-submission count immediately revokes any auto badge
 * whose threshold is no longer met. Leaves resubmitted untouched (issue #190)
 * — hiding a currently-visible photo is never itself a resubmit.
 *
 * `by` (issue #886) attributes WHO took it down and is written in the same
 * transaction as the flag flip. It defaults to 'admin' when omitted — a
 * compatibility contract, not an accident: both production routes pass the
 * actor explicitly (src/routes/admin.js 'admin', src/routes/community.js
 * 'guest'), so the callers still relying on this default are the pre-#886
 * one-argument call sites, all of them under tests/, which keep their
 * existing host-moderation semantics unchanged. Only an
 * EXPLICITLY passed value outside {'admin','guest'} is rejected, and it is
 * rejected loudly with a TypeError BEFORE any write runs — a caller bug
 * (typo, stale literal) fails fast at the call site instead of surfacing
 * three layers down as a SqliteError from the column's own CHECK
 * constraint. An omitted argument is never rejected: it is `undefined`,
 * which the default parameter turns into 'admin' before validation ever
 * sees it.
 * @param {number} submissionId
 * @param {'admin'|'guest'} [by] - who took the photo down. Defaults to 'admin'.
 * @returns {number|undefined} the submission's guest_id, or undefined if not found.
 */
function hideSubmission(submissionId, by = 'admin') {
  if (!VALID_TAKEN_DOWN_BY.has(by)) {
    throw new TypeError(
      `hideSubmission: 'by' must be 'admin' or 'guest' (or omitted), got ${JSON.stringify(by)}`
    );
  }
  return _setTakenDownAndRecount(submissionId, 1, by, false);
}

/**
 * Restore a previously hidden submission. Recomputes the guest's auto-badges
 * in the same transaction as the flag flip, so a restored submission
 * immediately re-grants any auto badge whose threshold is met again. Also
 * clears resubmitted in that same transaction (issue #190): once the host has
 * restored the row, there is no pending resubmit decision left to flag.
 * Clears taken_down_by back to NULL (issue #886) in that same transaction,
 * beside the resubmitted clear — a visible row carries no attribution, the
 * same rule a fresh submission's insert follows.
 * @param {number} submissionId
 * @returns {number|undefined} the submission's guest_id, or undefined if not found.
 */
function restoreSubmission(submissionId) {
  return _setTakenDownAndRecount(submissionId, 0, null, true);
}

// ---------------------------------------------------------------------------
// Hard delete (rarely used). Permanently removes BOTH files and the DB row.
// The admin UI uses takedown, not this. Provided for completeness / emergencies.
// ---------------------------------------------------------------------------

const _getSubmissionFiles = db.prepare(
  'SELECT photo_path, thumb_path FROM submissions WHERE id = ?'
);
const _deleteSubmissionRow = db.prepare('DELETE FROM submissions WHERE id = ?');

/**
 * Permanently delete a submission's files from disk and remove its row.
 * Safe to call even if a file is already missing (ignores "not found").
 * @param {number} submissionId
 * @returns {boolean} true if a row existed and was deleted.
 */
function hardDelete(submissionId) {
  const row = _getSubmissionFiles.get(submissionId);
  if (!row) return false;

  // Remove the original.
  if (row.photo_path) {
    try {
      fs.unlinkSync(absOriginalPath(row.photo_path));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // ignore "already gone"
    }
  }
  // Remove the thumbnail.
  if (row.thumb_path) {
    try {
      fs.unlinkSync(absThumbPath(row.thumb_path));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }

  const info = _deleteSubmissionRow.run(submissionId);
  return info.changes > 0;
}

// ---------------------------------------------------------------------------
// Access-control guard middlewares for static file mounts.
//
// blockTakenDownOriginal — mount before app.use('/uploads', express.static(...))
// blockTakenDownThumb    — mount before app.use('/thumbs',  express.static(...))
//
// Two-stage guard (per issue #34 design):
//   Stage 1: Allowlist the filename shape.  Any name that is NOT the exact shape
//            of a real stored filename is rejected immediately with 404.  This
//            kills the whole class of resolver-divergence bypasses (case-variants,
//            NTFS alternate-data-stream syntax, 8.3 short names, trailing dots/
//            spaces) without having to enumerate them.
//   Stage 2: Case-insensitive takedown check.  For an allowlisted name, query
//            the DB (COLLATE NOCASE) and 404 if it belongs to a taken-down
//            submission.  Avatars and live photos match no taken-down row, so
//            they pass through.
//
// decodeURIComponent is wrapped in try/catch: a malformed percent-escape (e.g.
// %ZZ) throws URIError — we catch it and return 404, never 500.
//
// ORIGINAL_RE and THUMB_RE (the stage-1 filename allowlists both guards
// check against) live in naming.js, next to randomFilename — see that
// file's own comments for what each pattern matches and why.
// ---------------------------------------------------------------------------

const _isTakenDownOriginal = db.prepare(
  `SELECT 1 FROM submissions
    WHERE photo_path = ? COLLATE NOCASE
      AND taken_down = 1
    LIMIT 1`
);

const _isTakenDownThumb = db.prepare(
  `SELECT 1 FROM submissions
    WHERE thumb_path = ? COLLATE NOCASE
      AND taken_down = 1
    LIMIT 1`
);

/**
 * Guard middleware for the /uploads static mount.
 * Blocks taken-down submission originals; passes avatars and live photos.
 * An authenticated admin (issue #191) bypasses the takedown 404 — moderation
 * needs to see what it is hiding in order to decide whether to restore it —
 * but still 404s a malformed/allowlist-failing path either way.
 */
function blockTakenDownOriginal(req, res, next) {
  let name;
  try {
    name = path.basename(decodeURIComponent(req.path));
  } catch {
    res.set('Cache-Control', 'no-store');
    return res.sendStatus(404);
  }

  // Stage 1: allowlist check — reject anything that is not a real stored name.
  // Fires before the admin bypass below, so it 404s admin traffic too — a
  // malformed name is never a real stored file, admin or not (issue #937).
  if (!ORIGINAL_RE.test(name)) {
    res.set('Cache-Control', 'no-store');
    return res.sendStatus(404);
  }

  // Admin bypass: an admin session sees taken-down files too (issue #191).
  // Cache-Control set here (issue #937) so the response is never marked
  // publicly cacheable — an admin's bypassed view of a possibly-taken-down
  // file must not sit in a shared/public cache, though the host's own
  // bodiless-304 revalidation still works under 'no-cache'. express.static's
  // send() only sets Cache-Control when the response doesn't already carry
  // one, so this survives through to the client.
  if (isAdminRequest(req)) {
    res.set('Cache-Control', 'private, no-cache');
    return next();
  }

  // Stage 2: takedown check (case-insensitive).
  const row = _isTakenDownOriginal.get(name);
  if (row) {
    res.set('Cache-Control', 'no-store');
    return res.sendStatus(404);
  }

  return next();
}

/**
 * Guard middleware for the /thumbs static mount.
 * Blocks taken-down submission thumbnails; passes live thumbnails.
 * Same admin bypass as blockTakenDownOriginal above (issue #191).
 */
function blockTakenDownThumb(req, res, next) {
  let name;
  try {
    name = path.basename(decodeURIComponent(req.path));
  } catch {
    res.set('Cache-Control', 'no-store');
    return res.sendStatus(404);
  }

  // Stage 1: allowlist check. Fires before the admin bypass below, so it
  // 404s admin traffic too (issue #937 — see blockTakenDownOriginal above).
  if (!THUMB_RE.test(name)) {
    res.set('Cache-Control', 'no-store');
    return res.sendStatus(404);
  }

  // Admin bypass: an admin session sees taken-down files too (issue #191).
  // Cache-Control set here (issue #937) — same rationale as
  // blockTakenDownOriginal above.
  if (isAdminRequest(req)) {
    res.set('Cache-Control', 'private, no-cache');
    return next();
  }

  // Stage 2: takedown check (case-insensitive).
  const row = _isTakenDownThumb.get(name);
  if (row) {
    res.set('Cache-Control', 'no-store');
    return res.sendStatus(404);
  }

  return next();
}

module.exports = {
  hiddenByOwningGuest,
  isStickyTakedown,
  hideSubmission,
  restoreSubmission,
  isTakenDown,
  hardDelete,
  blockTakenDownOriginal,
  blockTakenDownThumb,
};
