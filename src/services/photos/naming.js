// src/services/photos/naming.js
// Filename generation, safe-path derivation, and the static-mount filename allowlists (issue #979 split). We never
// trust the client's filename. We generate a random, collision-proof name and
// keep only a safe extension derived from the validated MIME type.
'use strict';

const path = require('path');
const crypto = require('crypto');

const { UPLOADS_DIR } = require('./constants');

// ---------------------------------------------------------------------------
// Filename generation.
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

// The exact shape of a filename our own diskStorage.filename() can produce:
// randomFilename() output (16 hex + '-' + ms timestamp) with one of our stored
// extensions, OR the provisional '.heic' a HEIC candidate is written under
// before resolveUploadedFile converts it. This is the SINGLE source of truth
// for "could our storage layer have written a file under this name," used to
// derive a safe path inside UPLOADS_DIR from a multer descriptor before any fs
// operation touches it — so a tainted descriptor can never steer a read/unlink
// outside UPLOADS_DIR (defense-in-depth; multer already sets the name itself).
// It is DELIBERATELY a superset of ORIGINAL_RE below (which excludes '.heic'):
// a '.heic' is only ever transient on disk mid-conversion, never a final
// stored/served name, so the static-mount allowlist stays heic-free.
const STORAGE_FILENAME_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp|heic)$/i;

// ORIGINAL_RE and THUMB_RE below live here (#979) so the three
// storage-filename regexes have one owner next to their producer,
// randomFilename. They are DELIBERATELY narrower than
// STORAGE_FILENAME_RE above: that regex is the superset that still admits the
// transient '.heic' name a HEIC candidate carries mid-conversion; these two
// exclude '.heic' on purpose, because a '.heic' file is never a final
// stored/served name — see each regex's own comment for the full reasoning.

// Stored original / avatar filenames:  <16 hex chars>-<ms timestamp>.<ext>
// Deliberately jpg/png/webp only, with no `.heic` variant (issue #281):
// resolveUploadedFile and saveAvatar convert every HEIC upload to JPEG before
// it is ever written under its final name, so a `.heic` file never reaches
// UPLOADS_DIR under a name matching this pattern — nothing to allowlist.
const ORIGINAL_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)$/i;

// Stored thumbnail filenames:  <16 hex chars>-<ms timestamp>.<ext>.jpg
// Same jpg/png/webp-only note as ORIGINAL_RE above applies to the embedded
// original extension here.
const THUMB_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)\.jpg$/i;

/**
 * Derive an absolute path inside UPLOADS_DIR from a multer descriptor's
 * filename, but ONLY if that filename matches the exact shape our storage layer
 * produces (STORAGE_FILENAME_RE). Strips any directory component first
 * (path.basename), then allowlists the name. Returns null for any name our
 * storage could not have produced, so callers fail closed instead of running an
 * fs operation against a tainted, possibly-traversing path.
 * @param {string} filename - multer descriptor's .filename
 * @returns {string|null} absolute path under UPLOADS_DIR, or null if unsafe.
 */
function safeUploadPath(filename) {
  const safeName = path.basename(String(filename || ''));
  if (!STORAGE_FILENAME_RE.test(safeName)) return null;
  return path.join(UPLOADS_DIR, safeName);
}

module.exports = {
  randomFilename,
  safeUploadPath,
  ORIGINAL_RE,
  THUMB_RE,
};
