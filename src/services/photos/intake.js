// src/services/photos/intake.js
// multer intake wiring (issue #979 split): the DISK-storage task-submission
// `upload`, the multi-file DISK-storage memory-batch `uploadMemoryBatch`, and
// the MEMORY-storage avatar `uploadAvatar` — the three multer instances plus
// the fileFilter/storage they share, and the resolveUploadedFile hand-off
// (heic.js) each disk-storage wrapper runs once multer itself is done.
'use strict';

const fs = require('fs');
const multer = require('multer');

const {
  MAX_UPLOAD_BYTES,
  ALLOWED_MIME_TO_EXT,
  HEIC_CANDIDATE_MIMES,
  DISALLOWED_TYPE_MESSAGE,
  UPLOADS_DIR,
} = require('./constants');
const { randomFilename, safeUploadPath } = require('./naming');
const { resolveUploadedFile } = require('./heic');

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
    // file.mimetype was already accepted by fileFilter before we get here,
    // but for a HEIC candidate (see HEIC_CANDIDATE_MIMES) that acceptance was
    // only provisional — fileFilter cannot read the file's bytes (see the
    // note on fileFilter below), so we do not yet know whether this is a
    // real HEIC, a lying/garbage upload, or something else entirely. `.heic`
    // is a safe provisional extension for that case: resolveUploadedFile
    // (called by the `upload`/`uploadMemoryBatch` wrappers right after this
    // multer instance finishes) either renames/replaces this file with a
    // real `.jpg` or deletes it — a bare `.heic` file is never left behind
    // for a route to see, and ORIGINAL_RE/THUMB_RE never match `.heic` names
    // so one could never be served even if cleanup were somehow skipped.
    const ext = ALLOWED_MIME_TO_EXT[file.mimetype] || '.heic';
    cb(null, randomFilename(ext));
  },
});

/**
 * Accept our real image mimetypes outright, and accept HEIC candidates
 * (image/heic, image/heif, or the generic application/octet-stream some
 * pickers use for HEIC — see HEIC_CANDIDATE_MIMES) PROVISIONALLY.
 *
 * API CONFIRMATION (node_modules/multer/lib/make-middleware.js): fileFilter
 * is invoked with a `file` object that has only
 * {fieldname, originalname, encoding, mimetype} — `file.stream` is not
 * attached via Object.defineProperty until AFTER fileFilter's callback
 * accepts the file. There is no way to read a single byte of the upload
 * here; the mimetype (attacker- or picker-controlled) is all we have. So a
 * true HEIC-by-signature decision cannot be made in fileFilter at all — it
 * is made afterward, once multer has actually written the bytes to disk, by
 * `resolveUploadedFile` (called from the `upload`/`uploadMemoryBatch`
 * wrappers below). A candidate that turns out NOT to be real HEIC (and is
 * not one of our real mimetypes) is rejected there instead, with the same
 * BAD_IMAGE_TYPE code and message a direct rejection here would carry —
 * the guest sees an identical outcome, just decided one step later.
 *
 * On rejection we pass an Error whose .message is safe to show the guest,
 * tagged with .code = 'BAD_IMAGE_TYPE' so callers can detect it specifically.
 * Shared by the task-submission `upload`, the memory-batch
 * `uploadMemoryBatch`, and the avatar `uploadAvatar` middlewares.
 */
function fileFilter(req, file, cb) {
  if (ALLOWED_MIME_TO_EXT[file.mimetype] || HEIC_CANDIDATE_MIMES.has(file.mimetype)) {
    cb(null, true); // accept (real type, or a HEIC candidate pending resolveUploadedFile)
    return;
  }
  const err = new Error(DISALLOWED_TYPE_MESSAGE);
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

// The raw multer middleware, bound to field "photo" — NOT exported directly.
// The exported `upload` wrapper below runs this, then resolves any HEIC
// candidate it wrote to disk before handing control back to the caller.
const rawUpload = multerInstance.single('photo');

/**
 * The middleware src/routes/guest.js calls directly as upload(req, res, cb)
 * (NOT as router middleware — see that file's POST /tasks/:id/submit). Runs
 * the real multer disk-storage middleware, then — on a successful multer
 * pass with a file present — resolves it via resolveUploadedFile (HEIC ->
 * JPEG conversion, or rejection of anything else that slipped past fileFilter
 * only provisionally). guest.js and submissions.submitPhoto never see a
 * HEIC file: by the time this callback fires, req.file already points at
 * whatever is really sitting on disk.
 */
function upload(req, res, cb) {
  rawUpload(req, res, function (err) {
    if (err || !req.file) {
      cb(err);
      return;
    }
    // res.locals.guest is set by attachGuest (a global middleware that runs
    // before every router), so the uploading guest is available here without
    // any change to the calling route.
    const guestId = res.locals.guest && res.locals.guest.id;
    resolveUploadedFile(req.file, guestId).then(
      () => cb(),
      (resolveErr) => cb(resolveErr)
    );
  });
}

// ---------------------------------------------------------------------------
// multer configuration: multi-file DISK storage for "memory" batches (issue
// #247 — a guest sharing photos straight to the gallery with no task). Reuses
// the SAME disk `storage` and `fileFilter` as the single task-submission
// `upload` above, so a memory photo goes through identical type/size
// validation, filename randomization, and HEIC handling.
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

// The raw multer middleware, bound to field "photos" — NOT exported
// directly; see the `uploadMemoryBatch` wrapper below.
const rawUploadMemoryBatch = multerMemoryBatchInstance.array('photos');

/**
 * Same idea as `upload` above, but for the multi-file "memory" batch (issue
 * #247), and — regression guard for issue #281 — for every HEIC file in
 * req.files, not just the first. Without converting every file here, the
 * shared fileFilter accepting HEIC candidates would let broken `.heic`
 * originals into the gallery through this path even though task submissions
 * were fixed, since this path shares the same fileFilter and storage.
 *
 * If ANY file in the batch fails resolution (rejected as not-really-HEIC, or
 * fails to convert), the WHOLE batch is failed and every file already
 * written for it (already-resolved ones AND not-yet-processed ones) is
 * deleted before the error reaches the caller — mirroring the old
 * fileFilter's behavior, where multer itself aborted (and cleaned up) the
 * entire request the instant ANY one file was rejected. This matters because
 * src/routes/guest.js's POST /memories only calls its own cleanup helper
 * (cleanupBatchOriginals) for the rate-limit/disk-space guards — on a plain
 * callback error it just flashes a message, trusting that no file was left
 * behind. That trust is now earned here instead of by multer's own abort,
 * now that the HEIC decision happens after multer is done.
 */
function uploadMemoryBatch(req, res, cb) {
  rawUploadMemoryBatch(req, res, async function (err) {
    if (err) {
      cb(err);
      return;
    }
    const files = req.files || [];
    // res.locals.guest is set by attachGuest before the routers; charge each
    // HEIC file's decode to this guest. On exceed mid-batch, resolveUploadedFile
    // throws and the whole batch is failed + cleaned up below (batch-atomic).
    const guestId = res.locals.guest && res.locals.guest.id;
    for (const file of files) {
      try {
        await resolveUploadedFile(file, guestId);
      } catch (resolveErr) {
        // Clean up every file written for this batch via a validated basename
        // (safeUploadPath) — never an fs op on a tainted descriptor path.
        // Already-resolved entries carry their new .jpg name here; unprocessed
        // ones their provisional name; both are storage-shaped. Cleanup is
        // best-effort: a failed unlink (anything other than "already gone") is
        // logged and swallowed, NEVER re-thrown — throwing here escapes this
        // async multer callback as an unhandled rejection and skips cb(), which
        // would hang the request. The upload is already being rejected; a
        // leftover file on disk is harmless by comparison.
        for (const f of files) {
          const safePath = safeUploadPath(f.filename);
          // Same multer-name invariant as resolveUploadedFile: every batch file
          // is storage-shaped, so safeUploadPath never returns null here — the
          // `continue` is a defensive backstop with no reachable trigger.
          /* v8 ignore next */
          if (!safePath) continue;
          try {
            fs.unlinkSync(safePath);
          } catch (unlinkErr) {
            if (unlinkErr.code !== 'ENOENT') {
              console.error('memory-batch cleanup unlink failed:', unlinkErr);
            }
          }
        }
        cb(resolveErr);
        return;
      }
    }
    cb();
  });
}

// ---------------------------------------------------------------------------
// multer configuration: MEMORY storage for avatar intake (issue #122).
// Shared by signup (auth.js POST /join) and profile-edit (guest.js
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

module.exports = {
  upload,
  uploadMemoryBatch,
  uploadAvatar,
  MEMORY_BATCH_MAX_FILES,
};
