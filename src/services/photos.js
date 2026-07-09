// src/services/photos.js
//
// Photo upload handling, thumbnails, storage, serving, takedown/restore.
//
// Responsibilities:
//   - Configure multer DISK storage that writes the original task-submission photo
//     straight to UPLOADS_DIR with a random crypto filename that keeps the original
//     extension. (Task-submission path: NO req.file.buffer — disk storage.)
//   - Configure multer MEMORY storage for avatar intake (field name "avatar"), shared
//     by both onboarding (auth.js) and profile-edit (guest.js) so avatar bytes always
//     arrive as req.file.buffer through the ONE mechanism (issue #122).
//   - Validate type (jpeg/png/webp) and size (15 MB) with clear errors.
//     HEIC/HEIF is deliberately REJECTED with actionable copy — see the
//     allowlist note below (issue #188).
//   - makeThumb(originalPath): sharp -> width-400 JPEG written to THUMBS_DIR.
//   - saveAvatar(buffer, guestId): persist an avatar that arrives as a Buffer
//     (via the uploadAvatar middleware below), writing it to UPLOADS_DIR and
//     recording it on the guests row.
//   - URL/path builders so routes/views can serve files at /uploads and /thumbs.
//   - hideSubmission/restoreSubmission: the single writer of taken_down for moderation —
//     flips the flag AND recomputes the guest's auto-badges in one transaction.
//   - hardDelete(submissionId): permanently remove BOTH files + the row (rarely used).
//
// STORAGE MODEL (reconciles sections 03/04/05, updated by issue #122):
//   * Task submissions  -> multer DISK storage via the exported `upload` middleware.
//                          The route reads req.file.path / req.file.filename. There is
//                          NO req.file.buffer on this path. makeThumb(req.file.path).
//   * Avatar intake     -> multer MEMORY storage via the exported `uploadAvatar`
//                          middleware (field name "avatar"), used by BOTH auth.js
//                          (onboarding) and guest.js (profile-edit), so it has a
//                          Buffer and calls saveAvatar(buffer, id).
//   These are the ONLY two upload paths. There is no saveSubmissionPhoto/deletePhotoFiles
//   function — section 04's submit handler uses `upload` + makeThumb + a manual INSERT.
//
// DESIGN DECISION (takedown vs delete): takedown HIDES a photo (taken_down=1) so it
// vanishes from gallery/profiles/scoring but the file stays on disk for the export ZIP;
// hardDelete is the separate, deliberate "remove the files forever" path the admin UI
// does NOT use by default.
//
// CONSTANTS OWNERSHIP: this file is the single source of truth for MAX_UPLOAD_BYTES,
// THUMB_WIDTH, and the allowed image types. config.js only supplies UPLOADS_DIR/THUMBS_DIR.
//
// sharp@0.35.2 installs PREBUILT libvips binaries for Windows x64 on Node 20 — no build
// tools (Visual Studio / node-gyp) are required.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const config = require('../../config');
const { db } = require('../db');
const scoring = require('./scoring');

// ---------------------------------------------------------------------------
// Constants. This file is the ONE place the photo-pipeline limits live, so the
// contract is not split across config.js and here. config.js only provides the
// two storage directories.
// ---------------------------------------------------------------------------

// 15 MB per uploaded file. A phone photo is ~2-6 MB; 15 MB is generous headroom
// and still protects the laptop's disk. Sized fine for ~15 photos/guest.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// Thumbnail width in pixels. 400 matches the gallery markup in section 07
// (img width=400 height=400, CSS aspect-ratio 1/1) so thumbs are not letterboxed
// or unexpectedly cropped, while staying tiny for the lazy-loading grid.
const THUMB_WIDTH = 400;

// JPEG quality for generated thumbnails (1-100). 78 is a good size/quality balance.
const THUMB_JPEG_QUALITY = 78;

// Accepted upload MIME types -> the file extension we store the original under.
//
// HEIC/HEIF is deliberately ABSENT (issue #188). The prebuilt sharp binaries
// this app runs on cannot decode real iPhone/Samsung HEIC: their bundled
// libheif has only an AV1 decoder (sharp.format.heif.input.fileSuffix ===
// ['.avif']), and HEVC is excluded for patent-licensing reasons. Accepting
// HEIC would store an original that can never be thumbnailed (makeThumb
// throws) and that most browsers cannot display. Do NOT re-add HEIC here
// without shipping an HEVC-capable libvips; the fileFilter below rejects it
// with copy that tells the guest what to do instead.
const ALLOWED_MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg', // some browsers/devices report this non-standard value
  'image/pjpeg': '.jpg', // progressive JPEG variant some clients send
  'image/png': '.png',
  'image/webp': '.webp',
};

// Human-readable list for error messages.
const ALLOWED_LABEL = 'JPEG, PNG, or WebP';

// HEIC/HEIF mimetypes get their own rejection copy: the generic "not allowed"
// message would leave iPhone/Samsung guests stuck, since their camera produces
// HEIC by default. Issue #188 binds tests to the phrases "photo format",
// "screenshot", and "Most Compatible"; keep them if the copy is reworded.
const HEIC_MIMES = new Set(['image/heic', 'image/heif']);
const HEIC_REJECTION_MESSAGE =
  "That photo format (HEIC) can't be uploaded here. Take a screenshot of the photo " +
  "and upload that, or switch your camera to 'Most Compatible' in Settings → Camera → Formats.";

// ---------------------------------------------------------------------------
// Resolve the storage directories from config and make sure they exist.
// app.js (section 01) also creates these on boot; we duplicate it here so this
// service works even if loaded in isolation (e.g. a future script).
// ---------------------------------------------------------------------------

const UPLOADS_DIR = path.resolve(config.UPLOADS_DIR);
const THUMBS_DIR = path.resolve(config.THUMBS_DIR);

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Filename generation.
// We never trust the client's filename. We generate a random, collision-proof
// name and keep only a safe extension derived from the validated MIME type.
// ---------------------------------------------------------------------------

/**
 * Build a random storage filename, e.g. "a1b2c3d4e5f60718-1719500000000.jpg".
 * @param {string} ext - leading-dot extension, e.g. ".jpg"
 * @returns {string}
 */
function randomFilename(ext) {
  const rand = crypto.randomBytes(8).toString('hex'); // 16 hex chars
  const stamp = Date.now(); // millisecond timestamp keeps names sortable + unique
  return `${rand}-${stamp}${ext}`;
}

// ---------------------------------------------------------------------------
// multer configuration: DISK storage straight into UPLOADS_DIR.
// This is the TASK-SUBMISSION path only. (Avatars use the memory-storage
// uploadAvatar middleware defined below in this file and go through
// saveAvatar() instead.)
// ---------------------------------------------------------------------------

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOADS_DIR);
  },
  filename: function (req, file, cb) {
    // file.mimetype was already validated by fileFilter before we get here.
    const ext = ALLOWED_MIME_TO_EXT[file.mimetype] || '.jpg';
    cb(null, randomFilename(ext));
  },
});

/**
 * Reject anything that is not one of our accepted image types.
 * On rejection we pass an Error whose .message is safe to show the guest, and we
 * tag it with .code = 'BAD_IMAGE_TYPE' so the route can detect it specifically.
 * HEIC/HEIF gets dedicated actionable copy (issue #188): the routes flash
 * err.message, so the guest-facing remedy lives here, in the single place the
 * rejection is decided. This filter is shared by the task-submission `upload`
 * and the avatar `uploadAvatar` middlewares, so HEIC avatars are rejected too —
 * intentionally: sharp cannot decode them either.
 */
function fileFilter(req, file, cb) {
  if (ALLOWED_MIME_TO_EXT[file.mimetype]) {
    cb(null, true); // accept
    return;
  }
  const message = HEIC_MIMES.has(file.mimetype)
    ? HEIC_REJECTION_MESSAGE
    : `That file type is not allowed. Please upload a ${ALLOWED_LABEL} image.`;
  const err = new Error(message);
  err.code = 'BAD_IMAGE_TYPE';
  cb(err, false); // reject
}

const multerInstance = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1, // exactly one photo per submission
  },
});

// The middleware the routes use: a single file under the form field name "photo".
// e.g. <input type="file" name="photo"> and upload.single('photo').
const upload = multerInstance.single('photo');

// ---------------------------------------------------------------------------
// multer configuration: multi-file DISK storage for "memory" batches (issue
// #247 — a guest sharing photos straight to the gallery with no task). Reuses
// the SAME disk `storage` and `fileFilter` as the single task-submission
// `upload` above, so a memory photo goes through identical type/size
// validation, filename randomization, and HEIC rejection copy.
//
// API NOTE (confirmed against node_modules/multer@2.2.0): this deliberately
// calls `.array('photos')` with NO maxCount argument, relying on the
// multer-INSTANCE-level `limits.files` cap instead of the per-field maxCount
// `.array(name, maxCount)` normally takes. Those are two different guards
// with two different error codes:
//   - `.array(name, maxCount)` installs a per-field counter
//     (lib/index.js `wrappedFileFilter`) that trips on the (maxCount+1)th
//     file with MulterError code LIMIT_UNEXPECTED_FILE ("Unexpected field").
//   - The multer-instance `limits.files` cap is enforced by busboy itself and
//     trips on the (limits.files+1)th file with MulterError code
//     LIMIT_FILE_COUNT ("Too many files") — see lib/make-middleware.js
//     `busboy.on('filesLimit', () => abortWithCode('LIMIT_FILE_COUNT'))`.
// The route (src/routes/guest.js POST /memories) catches LIMIT_FILE_COUNT
// specifically (the issue's designed AC2 behavior), so the count MUST come
// from limits.files, not from a maxCount argument to .array().
const MEMORY_BATCH_MAX_FILES = 10;

const multerMemoryBatchInstance = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: MEMORY_BATCH_MAX_FILES,
  },
});

// The middleware POST /memories uses: up to MEMORY_BATCH_MAX_FILES files
// under the form field name "photos". e.g. <input type="file" name="photos" multiple>.
const uploadMemoryBatch = multerMemoryBatchInstance.array('photos');

// ---------------------------------------------------------------------------
// multer configuration: MEMORY storage for avatar intake (issue #122).
// Shared by onboarding (auth.js POST /onboard) and profile-edit (guest.js
// POST /me/edit) so avatar bytes always arrive as req.file.buffer through the
// SAME mechanism — no route reads a file back off disk to get a Buffer.
// Field name is "avatar" (e.g. <input type="file" name="avatar">). Reuses the
// same MAX_UPLOAD_BYTES ceiling as task-submission photos so avatars and
// submissions cannot drift onto different limits.
// ---------------------------------------------------------------------------
const uploadAvatar = multer({
  storage: multer.memoryStorage(),
  fileFilter: fileFilter,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
  },
}).single('avatar');

// ---------------------------------------------------------------------------
// Thumbnail generation.
// ---------------------------------------------------------------------------

/**
 * Create a width-400 JPEG thumbnail in THUMBS_DIR from an original on disk.
 *
 * @param {string} originalPath - absolute or project-relative path to the original
 *        file that multer already wrote (use req.file.path).
 * @returns {Promise<string>} the thumbnail's RELATIVE filename (e.g. "ab12-...-1719.jpg.jpg"),
 *        i.e. what you store in submissions.thumb_path. (Just the filename, no folder.)
 *
 * Notes:
 *  - We derive the thumb filename from the original's FULL filename + ".jpg" so the
 *    two files are trivially correlated on disk. This means a .jpg original named
 *    "ab12-...-1719.jpg" produces a thumb "ab12-...-1719.jpg.jpg", a .webp original
 *    "<orig>.webp.jpg". The route stores EXACTLY this returned name in
 *    submissions.thumb_path, so /thumbs/<thumb_path> always resolves to the real file.
 *  - sharp's .rotate() with no args applies EXIF orientation, so iPhone photos that
 *    were taken sideways come out upright in the thumbnail.
 *  - withoutEnlargement keeps small images from being upscaled past their real size.
 *  - HEIC never reaches this function: the fileFilter rejects it at intake because
 *    prebuilt sharp has no HEVC decoder and would throw here (issue #188).
 */
async function makeThumb(originalPath) {
  const absOriginal = path.resolve(originalPath);
  const originalBase = path.basename(absOriginal); // e.g. "ab12cd...-1719.jpg"
  const thumbName = `${originalBase}.jpg`; // append .jpg so even .webp -> .webp.jpg
  const absThumb = path.join(THUMBS_DIR, thumbName);

  await sharp(absOriginal)
    .rotate() // honor EXIF orientation (upright phone photos)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: THUMB_JPEG_QUALITY })
    .toFile(absThumb);

  return thumbName; // store this EXACT value in submissions.thumb_path
}

// ---------------------------------------------------------------------------
// Avatar persistence (onboarding + profile-edit).
// Both routes run avatar bytes through the `uploadAvatar` middleware above
// (multer memoryStorage, field "avatar"), so both have req.file.buffer and
// call saveAvatar(req.file.buffer, guest.id). We write the bytes to UPLOADS_DIR
// (re-encoding to a normalized JPEG so oddly-encoded avatars are viewable everywhere) and
// record the stored filename on the guests row. Returns the stored filename.
// ---------------------------------------------------------------------------

const _setGuestAvatar = db.prepare('UPDATE guests SET avatar_path = ? WHERE id = ?');

/**
 * Persist an avatar that arrived as an in-memory Buffer.
 * @param {Buffer} buffer - the raw uploaded bytes (req.file.buffer via uploadAvatar)
 * @param {number} guestId - the guest to attach the avatar to
 * @returns {Promise<string>} the stored avatar filename (also written to guests.avatar_path)
 *
 * Notes:
 *  - We normalize to JPEG so an oddly-encoded avatar is viewable in any browser.
 *    (HEIC never reaches this function — the shared fileFilter rejects it at
 *    intake; prebuilt sharp could not decode it anyway. Issue #188.)
 *  - .rotate() honors EXIF orientation just like makeThumb.
 *  - The avatar is stored in UPLOADS_DIR and served via the /uploads mount, so use
 *    urlForOriginal(avatar_path) to build its URL.
 */
async function saveAvatar(buffer, guestId) {
  if (!buffer || !buffer.length) {
    throw new Error(
      'saveAvatar: empty buffer (caller must use the uploadAvatar memory-storage middleware).'
    );
  }
  const name = randomFilename('.jpg'); // avatars are always normalized to .jpg
  const absAvatar = path.join(UPLOADS_DIR, name);

  await sharp(buffer)
    .rotate() // honor EXIF orientation
    .resize({ width: 512, height: 512, fit: 'cover', position: 'attention' })
    .jpeg({ quality: 82 })
    .toFile(absAvatar);

  _setGuestAvatar.run(name, guestId);
  return name;
}

// ---------------------------------------------------------------------------
// Path / URL builders.
// submissions.photo_path and submissions.thumb_path (and guests.avatar_path) store
// the RELATIVE filename only (no directory). These helpers convert between filename,
// absolute disk path, and the public URL served by the static mounts in app.js.
// ---------------------------------------------------------------------------

/** Public URL for an original photo (or avatar), served by app.use('/uploads', ...). */
function urlForOriginal(photoPath) {
  if (!photoPath) return '';
  return '/uploads/' + photoPath;
}

/** Public URL for a thumbnail, served by app.use('/thumbs', ...). */
function urlForThumb(thumbPath) {
  if (!thumbPath) return '';
  return '/thumbs/' + thumbPath;
}

/** Absolute disk path of an original (used by export + hardDelete). */
function absOriginalPath(photoPath) {
  return path.join(UPLOADS_DIR, photoPath);
}

/** Absolute disk path of a thumbnail (used by hardDelete). */
function absThumbPath(thumbPath) {
  return path.join(THUMBS_DIR, thumbPath);
}

// ---------------------------------------------------------------------------
// Takedown / restore. These flip a flag; they do NOT touch files on disk.
// taken_down=1 hides a submission from gallery, profiles AND scoring (all of
// those queries filter on taken_down=0), while the file stays available for export.
//
// This file is the SINGLE WRITER of taken_down for moderation: hideSubmission
// and restoreSubmission are the only functions allowed to flip the flag for a
// takedown/restore, and each does the flip and the badge recount inside
// ONE db.transaction. better-sqlite3 nests transactions as SAVEPOINTs, so
// calling scoring.recomputeAfterSubmissionChange (itself a db.transaction)
// from inside this one is safe. Folding both writes into one transaction is what makes it
// impossible for a caller to flip the flag without the recount running too —
// no route may run its own `UPDATE submissions SET taken_down` for moderation.
// ---------------------------------------------------------------------------

const _getSubmissionGuest = db.prepare('SELECT guest_id FROM submissions WHERE id = ?');
const _setTakenDown = db.prepare('UPDATE submissions SET taken_down = ? WHERE id = ?');

/**
 * Flip a submission's taken_down flag and recompute the owning guest's
 * auto-badges, atomically. Returns the guest_id so callers can report success
 * without a second lookup; returns undefined if no such submission exists (so
 * callers can guard on that the same way they guarded a raw UPDATE before).
 * @param {number} submissionId
 * @param {0|1} takenDown
 * @returns {number|undefined} the submission's guest_id, or undefined if not found.
 */
const _setTakenDownAndRecount = db.transaction((submissionId, takenDown) => {
  const row = _getSubmissionGuest.get(submissionId);
  if (!row) return undefined;
  _setTakenDown.run(takenDown, submissionId);
  // One recompute seam runs the per-guest auto/metric pass and the global
  // transferable pass in order (issue #80) — a takedown/restore can change
  // who holds a transferable badge like MOSTPHOTOS, not just this guest's own
  // metric badges. The seam is itself a db.transaction, and better-sqlite3
  // nests transaction functions via SAVEPOINTs, so calling it from inside
  // this outer transaction is safe.
  scoring.recomputeAfterSubmissionChange(row.guest_id);
  return row.guest_id;
});

/**
 * Hide a submission (admin photo takedown). Keeps the file on disk for export.
 * Recomputes the guest's auto-badges in the same transaction as the flag flip,
 * so a dropped visible-submission count immediately revokes any auto badge
 * whose threshold is no longer met.
 * @param {number} submissionId
 * @returns {number|undefined} the submission's guest_id, or undefined if not found.
 */
function hideSubmission(submissionId) {
  return _setTakenDownAndRecount(submissionId, 1);
}

/**
 * Restore a previously hidden submission. Recomputes the guest's auto-badges
 * in the same transaction as the flag flip, so a restored submission
 * immediately re-grants any auto badge whose threshold is met again.
 * @param {number} submissionId
 * @returns {number|undefined} the submission's guest_id, or undefined if not found.
 */
function restoreSubmission(submissionId) {
  return _setTakenDownAndRecount(submissionId, 0);
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
// Cleanup helpers: remove an orphaned file from disk by filename.
// Used by the upload route if the DB insert fails AFTER multer wrote the file
// (e.g. the UNIQUE(guest_id,task_id) constraint rejects a duplicate submission),
// so we don't leave a stray file behind.
// ---------------------------------------------------------------------------

/**
 * Delete a stray original file by its relative filename. Ignores "not found".
 * @param {string} photoPath - relative filename, e.g. req.file.filename
 */
function deleteOriginalFile(photoPath) {
  if (!photoPath) return;
  try {
    fs.unlinkSync(absOriginalPath(photoPath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Delete a stray thumbnail file by its relative filename. Ignores "not found".
 * @param {string} thumbPath - relative filename returned by makeThumb()
 */
function deleteThumbFile(thumbPath) {
  if (!thumbPath) return;
  try {
    fs.unlinkSync(absThumbPath(thumbPath));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
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
// ---------------------------------------------------------------------------

// Stored original / avatar filenames:  <16 hex chars>-<ms timestamp>.<ext>
const ORIGINAL_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)$/i;

// Stored thumbnail filenames:  <16 hex chars>-<ms timestamp>.<ext>.jpg
const THUMB_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)\.jpg$/i;

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
 */
function blockTakenDownOriginal(req, res, next) {
  let name;
  try {
    name = path.basename(decodeURIComponent(req.path));
  } catch {
    return res.sendStatus(404);
  }

  // Stage 1: allowlist check — reject anything that is not a real stored name.
  if (!ORIGINAL_RE.test(name)) {
    return res.sendStatus(404);
  }

  // Stage 2: takedown check (case-insensitive).
  const row = _isTakenDownOriginal.get(name);
  if (row) {
    return res.sendStatus(404);
  }

  return next();
}

/**
 * Guard middleware for the /thumbs static mount.
 * Blocks taken-down submission thumbnails; passes live thumbnails.
 */
function blockTakenDownThumb(req, res, next) {
  let name;
  try {
    name = path.basename(decodeURIComponent(req.path));
  } catch {
    return res.sendStatus(404);
  }

  // Stage 1: allowlist check.
  if (!THUMB_RE.test(name)) {
    return res.sendStatus(404);
  }

  // Stage 2: takedown check (case-insensitive).
  const row = _isTakenDownThumb.get(name);
  if (row) {
    return res.sendStatus(404);
  }

  return next();
}

module.exports = {
  // multer middleware + the limit/type constants (handy for views + error text)
  upload,
  uploadAvatar,
  uploadMemoryBatch,
  MAX_UPLOAD_BYTES,
  MEMORY_BATCH_MAX_FILES,
  THUMB_WIDTH,
  ALLOWED_LABEL,

  // image processing
  makeThumb,
  saveAvatar,

  // path / URL builders
  urlForOriginal,
  urlForThumb,
  absOriginalPath,
  absThumbPath,

  // access-control guard middlewares (mount before the static mounts in app.js)
  blockTakenDownOriginal,
  blockTakenDownThumb,

  // takedown / restore (flag flip + auto-badge recount, atomic; files kept)
  hideSubmission,
  restoreSubmission,

  // destructive helpers
  hardDelete,
  deleteOriginalFile,
  deleteThumbFile,
};
