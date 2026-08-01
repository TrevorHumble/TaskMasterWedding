// src/services/photos/paths.js
// URL / path builders and stray-file cleanup helpers (issue #979 split).
// submissions.photo_path and submissions.thumb_path (and guests.avatar_path)
// store the RELATIVE filename only (no directory). These helpers convert
// between filename, absolute disk path, and the public URL served by the
// static mounts in app.js.
'use strict';

const fs = require('fs');
const path = require('path');

const config = require('../../../config');
const { UPLOADS_DIR, THUMBS_DIR } = require('./constants');

// ---------------------------------------------------------------------------
// Make sure the storage directories exist. app.js (section 01) also creates
// these on boot; this file duplicates that (#979 — it already owns path
// building) so the service works even if loaded in isolation (e.g. a
// future script).
// ---------------------------------------------------------------------------

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(THUMBS_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Path / URL builders.
// ---------------------------------------------------------------------------

/** Public URL for an original photo (or avatar), served by app.use(config.UPLOADS_URL_BASE, ...). */
function urlForOriginal(photoPath) {
  if (!photoPath) return '';
  return config.UPLOADS_URL_BASE + '/' + photoPath;
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
  urlForOriginal,
  urlForThumb,
  absOriginalPath,
  absThumbPath,
  deleteOriginalFile,
  deleteThumbFile,
};
