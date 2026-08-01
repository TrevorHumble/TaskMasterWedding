// src/routes/guest/memories.js
// GET /memories/new, POST /memories — the "share a memory" multi-photo batch
// upload (issue #991 split, seam table area "memories.js").

'use strict';

const express = require('express');
const router = express.Router();

// db.js exports an OBJECT { db, getGuestByToken, getGuestById, ... }.
// Destructure the better-sqlite3 connection itself, or db.prepare(...) is
// undefined.
const { db } = require('../../db');

// setFlash is the shared one-shot flash writer, the single owner of the
// signed `flash` cookie's shape. setMemoryBatchPartial (issue #931) writes
// the one-shot partial-batch-result cookie GET /memories/new below reads.
const { setFlash, setMemoryBatchPartial } = require('../../middleware/session');

// CSRF (issue #284): POST /memories runs multer manually, so req.body is not
// parsed until inside that callback — assertCsrf is the shared post-multer
// verifier every multer-driven route in this app calls immediately before
// any state change; rejectCsrf is the one shared 403 response, same literal
// as csrfMiddleware's own rejection.
const { assertCsrf, rejectCsrf } = require('../../middleware/csrf');

// withUploadSlot (issue #311 AC3, extended to memory batches by #857) bounds
// how many concurrent submitPhoto / submitMemoryBatch calls run their heavy
// thumbnail+DB-write pipeline at once -- see
// src/utils/upload-concurrency.js's file comment for why.
const { withUploadSlot } = require('../../utils/upload-concurrency');

// Photos service (section 05) — REAL exports only.
// `uploadMemoryBatch` is multer DISK storage bound to .array('photos').
const photos = require('../../services/photos');

// Submission-intake service (issue #106) — submitMemoryBatch owns the whole
// memory-batch persist sequence.
const submissions = require('../../services/submissions');

// Memory-upload abuse guardrails (issue #247). rate-limit service owns the
// per-guest limiter and the injectable free-space reader.
// Applied only to POST /memories below.
const rateLimit = require('../../services/rate-limit');

// Copy shown when a guest is over the memory rate limit (AC11) or the data
// volume is below MIN_FREE_DISK_BYTES (AC12). Kept as named constants so the
// route and the tests reference the same literal in one place.
const MEMORY_RATE_LIMIT_MESSAGE =
  "Whoa — that's a lot of memories at once. Give it a minute and try again.";
const MEMORY_DISK_FULL_MESSAGE = 'The gallery is full right now — please tell the hosts.';

const { withBadgeMoment } = require('../../services/render-locals');

// ---------------------------------------------------------------------------
// GET /memories/new  — the "share a memory" form (issue #247). Guest-gated by
// the router.use(requireGuest) in src/routes/guest.js's entry, same as every
// other route mounted there (AC6: a signed-out visitor is redirected to
// /join instead — issue #241).
//
// Issue #931: also the landing page for a partial-batch redirect. attachGuest
// (src/middleware/session.js) already read-and-cleared the one-shot
// memoryBatchPartial cookie into res.locals.memoryBatchPartial before this
// handler runs (same one-shot contract as flash/taskCompleteReward), so this
// route's only remaining job is turning that payload's ids into the saved
// photos' thumbnails — scoped to THIS request's guest (`guest_id = ?` in the
// query below), so a cookie replayed on a shared phone by a different signed-
// in guest can never surface someone else's photos.
// ---------------------------------------------------------------------------
router.get('/memories/new', function (req, res) {
  // Named partialCookie (not partialBatch) because it is the raw one-shot
  // cookie payload -- okIds/failed/droppedCount as attachGuest read it --
  // one line away from partialBatch below, the render-ready shape this
  // guest's own rows resolve into (#931 review NIT).
  const partialCookie = res.locals.memoryBatchPartial;
  let partialBatch = null;
  if (partialCookie) {
    // router.use(requireGuest) in src/routes/guest.js's entry gates every
    // route mounted there, so res.locals.guest is always set here -- no
    // `guest &&` guard needed (#931 review MINOR C).
    const guest = res.locals.guest;
    let okThumbs = [];
    if (partialCookie.okIds.length > 0) {
      const placeholders = partialCookie.okIds.map(() => '?').join(',');
      // AND taken_down = 0: the canonical visibility filter every other
      // submissions read in this router applies (see src/routes/guest/home.js's
      // GET / and src/routes/guest/tasks.js's GET /tasks and GET /tasks/:id)
      // -- without it a moderated-down photo would still render its
      // thumbnail into this guest's own result card (#931 review MAJOR 1).
      const rows = db
        .prepare(
          `SELECT thumb_path FROM submissions WHERE guest_id = ? AND taken_down = 0 AND id IN (${placeholders}) ORDER BY id ASC`
        )
        .all(guest.id, ...partialCookie.okIds);
      okThumbs = rows.map((r) => r.thumb_path);
    }
    // The card's headline count must come from rows THIS guest actually
    // owns, not the raw cookie: a cookie replayed under a different signed-
    // in guest (shared phone) would otherwise render a false "N of your
    // photos are in the gallery" claim with none of them actually this
    // guest's own (#931 review MINOR A). If the cookie claims saved photos
    // but none resolve for this guest, show no card at all.
    if (partialCookie.okIds.length > 0 && okThumbs.length === 0) {
      partialBatch = null;
    } else {
      // failedCount is the single owner of "how many files failed,
      // including any the cookie's byte budget dropped" -- computed once
      // here and consumed both by totalCount below and by
      // memory-new.ejs's failed-line copy, rather than the same
      // failed.length + droppedCount formula being re-derived in both
      // places (#931 review MAJOR 2; this is the file's answer to the
      // Duplicated-ownership self-check).
      const failedCount = partialCookie.failed.length + partialCookie.droppedCount;
      partialBatch = {
        okCount: okThumbs.length,
        totalCount: okThumbs.length + failedCount,
        okThumbs: okThumbs,
        failed: partialCookie.failed,
        droppedCount: partialCookie.droppedCount,
        failedCount: failedCount,
      };
    }
  }
  res.render(
    'memory-new',
    withBadgeMoment(req, res, { title: 'Share a memory', partialBatch: partialBatch })
  );
});

// ---------------------------------------------------------------------------
// POST /memories  — handle the multi-photo "memory" batch upload.
// Field name is "photos" (multiple, up to photos.MEMORY_BATCH_MAX_FILES).
// photos.uploadMemoryBatch is multer DISK storage bound to .array('photos');
// after it runs, req.files is an array of { filename, path, ... } descriptors
// (empty array if none were attached — multer's `files` limit is a maximum,
// not a minimum, so zero files is not itself a multer error).
//
// The 11th file trips multer's own files-limit guard with MulterError code
// LIMIT_FILE_COUNT (see photos.js's uploadMemoryBatch doc comment for why —
// NOT the LIMIT_UNEXPECTED_FILE a naive `.array('photos', 10)` would throw
// instead). That case re-renders the form directly (no redirect) with the
// literal copy AC2 requires, and inserts no rows — submissions.submitMemoryBatch
// is never called in that branch.
//
// Abuse guardrails (issue #247), applied AFTER multer parses the batch but
// BEFORE any row or thumbnail is written:
//   - Rate limit (AC11): at most MEMORY_RATE_MAX batches per guest per
//     MEMORY_RATE_WINDOW_MS. Over the limit, the batch is rejected.
//   - Disk-space guard (AC12): if free space on the data volume is below
//     MIN_FREE_DISK_BYTES, the batch is rejected.
// Multer's disk storage has already written the originals to UPLOADS_DIR by
// the time this callback runs, so a rejecting guard deletes those originals
// (cleanupBatchOriginals) and never calls submitMemoryBatch — so a rejected
// batch leaves zero rows AND zero files behind (no residue), and no
// thumbnails are ever generated for it.
// ---------------------------------------------------------------------------

// Delete the originals multer already wrote for a batch we are about to
// reject, so a rejected batch leaves no file residue on disk. No thumbnails
// exist yet at any rejection point (submitMemoryBatch has not run), so only
// the originals need removing.
function cleanupBatchOriginals(files) {
  for (const file of files) {
    photos.deleteOriginalFile(file.filename);
  }
}

router.post('/memories', function (req, res, next) {
  photos.uploadMemoryBatch(req, res, async function (err) {
    const guest = res.locals.guest;

    if (err) {
      if (err.code === 'LIMIT_FILE_COUNT') {
        return res.render(
          'memory-new',
          withBadgeMoment(req, res, {
            title: 'Share a memory',
            error: 'Ten photos at a time — send the rest in a second batch.',
          })
        );
      }
      // Any other multer/file-filter error (size limit or disallowed type,
      // including the shared HEIC-rejection copy — issue #188).
      setFlash(res, 'error', 'That batch could not be uploaded: ' + err.message);
      return res.redirect('/memories/new');
    }

    const files = req.files || [];
    if (files.length === 0) {
      setFlash(res, 'error', 'Please choose at least one photo to share.');
      return res.redirect('/memories/new');
    }

    // CSRF check (issue #284): now that multer has parsed the body,
    // req.body._csrf (the hidden field partials/csrf-field.ejs renders as
    // the FIRST field in memory-new.ejs's form) is available as a second
    // chance for a no-JS native multipart submit, alongside the header
    // csrfMiddleware may already have verified. Runs before the rate-limit
    // guard below consumes the guest's budget and before any row is
    // written — cleanupBatchOriginals removes the originals multer already
    // wrote to disk, the same cleanup every other rejection branch in this
    // handler already performs.
    if (!assertCsrf(req)) {
      cleanupBatchOriginals(files);
      rejectCsrf(res);
      return;
    }

    // Rate-limit guard (AC11). recordMemoryAttempt only consumes the guest's
    // budget when it ALLOWS the attempt, so a rejected batch does not extend
    // the penalty past the real window. Reject before persisting; clean up the
    // originals multer wrote so nothing is left behind.
    const rl = rateLimit.recordMemoryAttempt(guest.id);
    if (!rl.allowed) {
      cleanupBatchOriginals(files);
      return res.render(
        'memory-new',
        withBadgeMoment(req, res, {
          title: 'Share a memory',
          error: MEMORY_RATE_LIMIT_MESSAGE,
        })
      );
    }

    // Disk-space guard (AC12). Read free space via the injectable reader; a
    // reader failure is a real server error, so route it to next(err) rather
    // than silently letting the batch through. Reject before submitMemoryBatch
    // writes any thumbnail; clean up the originals so no files remain.
    let spaceOk;
    try {
      spaceOk = await rateLimit.hasFreeSpace();
    } catch (spaceErr) {
      cleanupBatchOriginals(files);
      return next(spaceErr);
    }
    if (!spaceOk) {
      cleanupBatchOriginals(files);
      return res.render(
        'memory-new',
        withBadgeMoment(req, res, {
          title: 'Share a memory',
          error: MEMORY_DISK_FULL_MESSAGE,
        })
      );
    }

    // Persist the batch. Wrapped so a thrown error routes to the Express error
    // handler (next(err)) rather than becoming an unhandled promise rejection
    // that hangs the request (plan step 9b).
    //
    // Issue #857: also run through withUploadSlot, the same concurrency gate
    // POST /tasks/:id/submit (src/routes/guest/tasks.js) uses (see the
    // comment above that route and src/utils/upload-concurrency.js).
    // submitMemoryBatch runs the identical sharp thumbnail pipeline up to 10
    // times per batch (sequentially, so one slot per batch is the right
    // granularity -- see submissions.js), and without this gate a burst of
    // guests sharing memories at once could drive far more concurrent sharp
    // work than MAX_CONCURRENT_UPLOADS was sized to bound.
    let result;
    try {
      result = await withUploadSlot(() =>
        submissions.submitMemoryBatch({
          guestId: guest.id,
          files: files,
          caption: req.body.caption,
        })
      );
    } catch (batchErr) {
      return next(batchErr);
    }

    const okIds = result.submissionIds || [];
    const failedNames = result.failed || [];

    // If every file failed to thumbnail, submitMemoryBatch inserts zero rows —
    // do NOT tell the guest the batch was shared when nothing was (plan step
    // 9a). Surface an error instead. Unchanged from before issue #931 (AC5).
    if (okIds.length === 0) {
      setFlash(res, 'error', "Sorry, we couldn't save those photos. Please try again.");
      return res.redirect('/memories/new');
    }

    // Partial batch (issue #931 AC1/AC2): some photos saved, some did not.
    // The unconditional "Shared!" flash below would tell a guest who just
    // lost 3 of 10 photos that everything made it — write the one-shot
    // partial-result cookie instead and land back on the form, where the
    // card (transcribed from the owner-approved phase-1 mock) reports the
    // count and the failed filenames.
    if (failedNames.length > 0) {
      setMemoryBatchPartial(res, okIds, failedNames);
      return res.redirect('/memories/new');
    }

    // Unchanged common case (AC4): every file in the batch saved.
    setFlash(res, 'success', "Shared! They're in the gallery.");
    return res.redirect('/gallery');
  });
});

module.exports = router;
