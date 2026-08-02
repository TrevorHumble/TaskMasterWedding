// src/services/photos.js
//
// Photo upload handling, thumbnails, storage, serving, takedown/restore —
// entry (issue #979 split). Internals live under src/services/photos/:
// constants.js (pipeline limits + resolved UPLOADS_DIR/THUMBS_DIR),
// naming.js (random filenames, safe-path derivation + the storage-filename allowlists), heic.js (HEIC
// detection/pixel-cap/worker-decode/convert + resolveUploadedFile),
// intake.js (multer disk/memory storage, fileFilter, and the upload/
// uploadAvatar/uploadMemoryBatch wrappers), processing.js (makeThumb,
// saveAvatar), paths.js (URL/path builders + stray-file cleanup), and
// moderation.js (takedown/restore/hardDelete + the static-serving takedown
// guards). This file's own require path (`require('./photos')`/
// `require('../services/photos')`) and full public API are unchanged.
//
// Responsibilities:
//   - Configure multer DISK storage that writes the original task-submission
//     photo straight to UPLOADS_DIR with a random crypto filename that keeps
//     the original extension. (Task-submission path: NO req.file.buffer —
//     disk storage.)
//   - Configure multer MEMORY storage for avatar intake (field name "avatar"),
//     shared by both onboarding (auth.js) and profile-edit (guest.js) so
//     avatar bytes always arrive as req.file.buffer through the ONE mechanism
//     (issue #122).
//   - Validate type (jpeg/png/webp/HEIC) and size (15 MB) with clear errors.
//     HEIC/HEIF is CONVERTED to JPEG at intake (issue #281, superseding
//     #188's rejection) — see the allowlist note below and the
//     `upload`/`uploadMemoryBatch`/`saveAvatar` doc comments for where the
//     conversion actually happens.
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
// CONSTANTS OWNERSHIP: src/services/photos/constants.js is the single source of
// truth for MAX_UPLOAD_BYTES, THUMB_WIDTH, and the allowed image types. config.js
// only supplies UPLOADS_DIR/THUMBS_DIR.
//
// sharp@0.35.2 installs PREBUILT libvips binaries for Windows x64 on Node 20 — no build
// tools (Visual Studio / node-gyp) are required.

'use strict';

const constants = require('./photos/constants');
const naming = require('./photos/naming');
const heic = require('./photos/heic');
const intake = require('./photos/intake');
const processing = require('./photos/processing');
const paths = require('./photos/paths');
const moderation = require('./photos/moderation');

module.exports = {
  // multer middleware + the limit/type constants (handy for views + error text)
  upload: intake.upload,
  uploadAvatar: intake.uploadAvatar,
  uploadMemoryBatch: intake.uploadMemoryBatch,
  MAX_UPLOAD_BYTES: constants.MAX_UPLOAD_BYTES,
  MEMORY_BATCH_MAX_FILES: intake.MEMORY_BATCH_MAX_FILES,
  THUMB_WIDTH: constants.THUMB_WIDTH,
  ALLOWED_LABEL: constants.ALLOWED_LABEL,

  // image processing
  makeThumb: processing.makeThumb,
  saveAvatar: processing.saveAvatar,

  // HEIC pixel-bomb guard (exported for direct unit testing — see
  // tests/heic-conversion.test.js). MAX_HEIC_PIXELS is the single cap;
  // heicPixelDimensions reads declared dims from the `ispe` box without
  // decoding; assertHeicPixelsWithinCap is the throw-if-oversized gate.
  MAX_HEIC_PIXELS: constants.MAX_HEIC_PIXELS,
  heicPixelDimensions: heic.heicPixelDimensions,
  assertHeicPixelsWithinCap: heic.assertHeicPixelsWithinCap,

  // The live HEIC-decode admission gate (issue #930) — exported so tests can
  // observe .active/.pending directly, the same "import the live singleton"
  // pattern tests/memories.test.js uses for
  // src/utils/upload-concurrency.js's uploadSemaphore.
  heicDecodeSemaphore: heic.heicDecodeSemaphore,

  // safe-path derivation from a multer descriptor's filename (exported for
  // direct unit testing of both the allowlisted and fail-closed arms).
  safeUploadPath: naming.safeUploadPath,

  // path / URL builders
  urlForOriginal: paths.urlForOriginal,
  urlForThumb: paths.urlForThumb,
  absOriginalPath: paths.absOriginalPath,
  absThumbPath: paths.absThumbPath,

  // access-control guard middlewares (mount before the static mounts in app.js)
  blockTakenDownOriginal: moderation.blockTakenDownOriginal,
  blockTakenDownThumb: moderation.blockTakenDownThumb,

  // takedown / restore (flag flip + auto-badge recount, atomic; files kept)
  hideSubmission: moderation.hideSubmission,
  restoreSubmission: moderation.restoreSubmission,
  isTakenDown: moderation.isTakenDown,
  // the single owner of the "hidden by the owning guest" predicate (#886),
  // and its composed "is this row sticky" predicate —
  // callers use these instead of each re-deriving the conjunction.
  hiddenByOwningGuest: moderation.hiddenByOwningGuest,
  isStickyTakedown: moderation.isStickyTakedown,

  // destructive helpers
  hardDelete: moderation.hardDelete,
  deleteOriginalFile: paths.deleteOriginalFile,
  deleteThumbFile: paths.deleteThumbFile,
};
