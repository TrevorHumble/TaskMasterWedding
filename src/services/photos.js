// src/services/photos.js
//
// Photo upload handling, thumbnails, storage, serving, takedown/restore.
//
// Responsibilities:
//   - Configure multer DISK storage that writes the original task-submission photo
//     straight to UPLOADS_DIR with a random crypto filename that keeps the original
//     extension. (Task-submission path: NO req.file.buffer — disk storage.)
//   - Validate type (jpeg/png/webp/heic) and size (15 MB) with clear errors.
//   - makeThumb(originalPath): sharp -> width-400 JPEG written to THUMBS_DIR.
//   - saveAvatar(buffer, guestId): persist an onboarding avatar that arrives as a
//     Buffer (auth.js section 03 uses multer MEMORY storage for the 'avatar' field),
//     writing it to UPLOADS_DIR and recording it on the guests row.
//   - URL/path builders so routes/views can serve files at /uploads and /thumbs.
//   - hideSubmission/restoreSubmission: flip submissions.taken_down (HIDE, keep file).
//   - hardDelete(submissionId): permanently remove BOTH files + the row (rarely used).
//
// STORAGE MODEL (reconciles sections 03/04/05):
//   * Task submissions  -> multer DISK storage via the exported `upload` middleware.
//                          The route reads req.file.path / req.file.filename. There is
//                          NO req.file.buffer on this path. makeThumb(req.file.path).
//   * Onboarding avatar -> auth.js (03) uses multer MEMORY storage for the 'avatar'
//                          field, so it has a Buffer, and calls saveAvatar(buffer, id).
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
// sharp@0.33.5 installs PREBUILT libvips binaries for Windows x64 on Node 20 — no build
// tools (Visual Studio / node-gyp) are required.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const sharp = require('sharp');

const config = require('../../config');
const { db } = require('../db');

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
// HEIC is what iPhones produce by default and acceptance is INTENTIONAL so guests
// uploading straight from an iPhone are not rejected. We store HEIC originals as-is
// (.heic) and let sharp convert to JPEG only for the thumbnail.
const ALLOWED_MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg', // some browsers/devices report this non-standard value
  'image/pjpeg': '.jpg', // progressive JPEG variant some clients send
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heic',
};

// Human-readable list for error messages.
const ALLOWED_LABEL = 'JPEG, PNG, WebP, or HEIC';

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
// This is the TASK-SUBMISSION path only. (Avatars use memory storage configured
// in auth.js and go through saveAvatar() instead.)
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
 */
function fileFilter(req, file, cb) {
  if (ALLOWED_MIME_TO_EXT[file.mimetype]) {
    cb(null, true); // accept
    return;
  }
  const err = new Error(`That file type is not allowed. Please upload a ${ALLOWED_LABEL} image.`);
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
 *    "ab12-...-1719.jpg" produces a thumb "ab12-...-1719.jpg.jpg" and a .heic original
 *    produces "<orig>.heic.jpg". The route stores EXACTLY this returned name in
 *    submissions.thumb_path, so /thumbs/<thumb_path> always resolves to the real file.
 *  - sharp's .rotate() with no args applies EXIF orientation, so iPhone photos that
 *    were taken sideways come out upright in the thumbnail.
 *  - withoutEnlargement keeps small images from being upscaled past their real size.
 *  - sharp reads HEIC originals fine via its bundled libvips and outputs JPEG.
 */
async function makeThumb(originalPath) {
  const absOriginal = path.resolve(originalPath);
  const originalBase = path.basename(absOriginal); // e.g. "ab12cd...-1719.jpg"
  const thumbName = `${originalBase}.jpg`; // append .jpg so even .heic -> .heic.jpg
  const absThumb = path.join(THUMBS_DIR, thumbName);

  await sharp(absOriginal)
    .rotate() // honor EXIF orientation (upright phone photos)
    .resize({ width: THUMB_WIDTH, withoutEnlargement: true })
    .jpeg({ quality: THUMB_JPEG_QUALITY })
    .toFile(absThumb);

  return thumbName; // store this EXACT value in submissions.thumb_path
}

// ---------------------------------------------------------------------------
// Avatar persistence (onboarding).
// auth.js (section 03) configures its OWN multer.memoryStorage() for the single
// 'avatar' field, so on that route — and ONLY that route — it has req.file.buffer.
// It calls saveAvatar(req.file.buffer, guest.id). We write the bytes to UPLOADS_DIR
// (re-encoding to a normalized JPEG so HEIC/odd avatars are viewable everywhere) and
// record the stored filename on the guests row. Returns the stored filename.
// ---------------------------------------------------------------------------

const _setGuestAvatar = db.prepare('UPDATE guests SET avatar_path = ? WHERE id = ?');

/**
 * Persist an onboarding avatar that arrived as an in-memory Buffer.
 * @param {Buffer} buffer - the raw uploaded bytes (req.file.buffer from auth.js)
 * @param {number} guestId - the guest to attach the avatar to
 * @returns {Promise<string>} the stored avatar filename (also written to guests.avatar_path)
 *
 * Notes:
 *  - We normalize to JPEG so a HEIC avatar from an iPhone is viewable in any browser.
 *  - .rotate() honors EXIF orientation just like makeThumb.
 *  - The avatar is stored in UPLOADS_DIR and served via the /uploads mount, so use
 *    urlForOriginal(avatar_path) to build its URL.
 */
async function saveAvatar(buffer, guestId) {
  if (!buffer || !buffer.length) {
    throw new Error('saveAvatar: empty buffer (onboarding must use multer memoryStorage for the avatar field).');
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
// ---------------------------------------------------------------------------

const _setTakenDown = db.prepare('UPDATE submissions SET taken_down = ? WHERE id = ?');

/**
 * Hide a submission (admin photo takedown). Keeps the file on disk for export.
 * @param {number} submissionId
 * @returns {boolean} true if a row was changed.
 */
function hideSubmission(submissionId) {
  const info = _setTakenDown.run(1, submissionId);
  return info.changes > 0;
}

/**
 * Restore a previously hidden submission.
 * @param {number} submissionId
 * @returns {boolean} true if a row was changed.
 */
function restoreSubmission(submissionId) {
  const info = _setTakenDown.run(0, submissionId);
  return info.changes > 0;
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

module.exports = {
  // multer middleware + the limit/type constants (handy for views + error text)
  upload,
  MAX_UPLOAD_BYTES,
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

  // takedown / restore (flag flips, files kept)
  hideSubmission,
  restoreSubmission,

  // destructive helpers
  hardDelete,
  deleteOriginalFile,
  deleteThumbFile,
};
