// src/services/photos/processing.js
// Thumbnail generation (makeThumb) and avatar persistence (saveAvatar) —
// issue #979 split. Both are sharp-backed image processing steps that run
// AFTER intake has already resolved HEIC to JPEG (makeThumb) or must resolve
// it itself inline (saveAvatar, which has no separate resolveUploadedFile
// step on the memory-storage avatar path).
'use strict';

const path = require('path');
const sharp = require('sharp');

const config = require('../../../config');
const { db } = require('../../db');
const { withAvatarSlot, AVATAR_GATE_CODES } = require('../../utils/upload-concurrency');
const {
  THUMB_WIDTH,
  THUMB_JPEG_QUALITY,
  UPLOADS_DIR,
  THUMBS_DIR,
  GUEST_SAFE_CONVERT_CODES,
} = require('./constants');
const { randomFilename } = require('./naming');
const { looksLikeHeic, assertHeicDecodeAllowed, convertHeicToJpeg } = require('./heic');

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
 *  - HEIC never reaches this function: `upload`/`uploadMemoryBatch`'s
 *    resolveUploadedFile step already converted any HEIC to JPEG (and
 *    rewrote req.file(s).path to the JPEG) before makeThumb is ever called —
 *    prebuilt sharp still has no HEVC decoder and would throw on real HEIC
 *    bytes (issue #281, superseding #188's rejection-at-intake).
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
// Both routes run avatar bytes through the `uploadAvatar` middleware
// (intake.js; multer memoryStorage, field "avatar"), so both have req.file.buffer and
// call saveAvatar(req.file.buffer, guest.id). We write the bytes to UPLOADS_DIR
// (re-encoding to a normalized JPEG so oddly-encoded avatars are viewable everywhere) and
// record the stored filename on the guests row. Returns the stored filename.
// ---------------------------------------------------------------------------

const _setGuestAvatar = db.prepare('UPDATE guests SET avatar_path = ? WHERE id = ?');

/**
 * Persist an avatar that arrived as an in-memory Buffer.
 * @param {Buffer} buffer - the raw uploaded bytes (req.file.buffer via uploadAvatar)
 * @param {number} guestId - the guest to attach the avatar to
 * @returns {Promise<string|null>} the stored avatar filename (also written to
 *   guests.avatar_path), or null when the issue #929 avatar concurrency gate
 *   (withAvatarSlot) rejected this save with AVATAR_QUEUE_BUSY or
 *   AVATAR_SLOT_TIMEOUT. A gate rejection costs the guest nothing but the
 *   avatar itself (they can add one later from their profile), so it is
 *   deliberately NOT thrown here -- every other caller that ever runs
 *   concurrently with saveAvatar (intake.js's task-submit `upload` and
 *   memory-batch `uploadMemoryBatch` wrappers) must never be dragged down
 *   by one guest's avatar losing a race for a slot. Every OTHER failure
 *   (a corrupt/undecodable image, a HEIC decode
 *   error, an over-cap HEIC) still throws, unchanged. Callers treat a null
 *   return as "no avatar this time": src/routes/guest.js's POST /me/edit
 *   flashes the existing "could not save" copy but keeps guest.avatar_path
 *   unchanged and still persists the rest of that save (name/PIN/socials);
 *   POST /join's trySaveAvatar already treats "no avatar" as a no-op via its
 *   existing null/no-file handling, so it needs no change.
 *
 * Notes:
 *  - We normalize to JPEG so an oddly-encoded avatar is viewable in any browser.
 *  - HEIC CAN reach this function now (issue #281): the shared fileFilter
 *    accepts HEIC candidates provisionally (see fileFilter's doc comment),
 *    and unlike the disk-storage paths there is no separate
 *    resolveUploadedFile step for memory-storage avatars — the conversion
 *    happens right here, before the existing sharp re-encode, since sharp
 *    still cannot decode real HEVC HEIC on its own.
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

  let sourceBuffer = buffer;
  if (looksLikeHeic(buffer)) {
    // Charge this HEIC avatar decode to the guest's per-guest decode budget
    // BEFORE the decode, same as the disk paths (issue #281). Throws
    // HEIC_RATE_LIMITED when over the limit; the caller surfaces it.
    assertHeicDecodeAllowed(guestId);
    try {
      // Avatar bytes are already fully in RAM (multer memoryStorage) — the
      // `prefix` convertHeicToJpeg's stage-1 check reads is just a subarray
      // of the same buffer (Buffer#subarray clamps to buffer.length, so a
      // short avatar naturally yields prefixTruncated: false — there is
      // nothing beyond the buffer for it to have cut off), and the supplier
      // hands back that same buffer with no re-read (issue #930 — mirrors
      // resolveUploadedFile's deferred-read disk-path supplier, but here
      // there is nothing to defer: the bytes are already resident, so
      // convertHeicToJpeg's supplier pattern costs nothing extra while
      // queued — it does NOT mean this decode is cheap to queue behind: the
      // full `buffer` is already pinned in RAM before this call, for the
      // whole wait, unlike a disk caller's deferred read. See DESIGN.md's
      // "Global pending-decode cap and admission" entry.
      sourceBuffer = await convertHeicToJpeg(
        {
          prefix: buffer.subarray(0, config.HEIC_ADMISSION_SNIFF_BYTES),
          prefixTruncated: buffer.length > config.HEIC_ADMISSION_SNIFF_BYTES,
        },
        () => buffer
      );
    } catch (convertErr) {
      // Let our own guest-safe coded errors through (pixel cap / global cap —
      // same reasoning as resolveUploadedFile); only a raw/uncoded decode
      // failure, timeout, or worker-infrastructure error gets the generic
      // avatar copy.
      if (GUEST_SAFE_CONVERT_CODES.has(convertErr.code)) {
        throw convertErr;
      }
      throw new Error("Sorry, that avatar photo couldn't be read. Please try a different photo.", {
        cause: convertErr,
      });
    }
  }

  const name = randomFilename('.jpg'); // avatars are always normalized to .jpg
  const absAvatar = path.join(UPLOADS_DIR, name);

  // Issue #929: only the sharp crop below runs inside the avatar concurrency
  // gate -- the HEIC conversion above (if any) stays OUTSIDE it, since that
  // decode already has its own process-wide serialization, pixel cap, and
  // per-guest rate limit. Holding a gate slot across the HEIC decode itself
  // would stall the unrelated, patient task-submit/memory-batch waiters on
  // the shared upload semaphore behind one guest's avatar -- see
  // src/utils/upload-concurrency.js's module header for the full rationale.
  try {
    await withAvatarSlot(() =>
      sharp(sourceBuffer)
        .rotate() // honor EXIF orientation
        .resize({ width: 512, height: 512, fit: 'cover', position: 'attention' })
        .jpeg({ quality: 82 })
        .toFile(absAvatar)
    );
  } catch (gateErr) {
    // A gate rejection (AVATAR_QUEUE_BUSY/AVATAR_SLOT_TIMEOUT) is "no avatar
    // this time," not a hard failure -- see this function's own doc comment.
    // Anything else (a sharp failure on a genuinely bad sourceBuffer) still
    // throws, unchanged.
    if (gateErr && AVATAR_GATE_CODES.has(gateErr.code)) {
      return null;
    }
    throw gateErr;
  }

  _setGuestAvatar.run(name, guestId);
  return name;
}

module.exports = {
  makeThumb,
  saveAvatar,
};
