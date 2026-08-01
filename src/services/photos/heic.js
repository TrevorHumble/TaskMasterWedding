// src/services/photos/heic.js
// HEIC detection + pixel-cap + worker-decode + convert (issue #979 split).
// Shared by the disk-storage `upload`/`uploadMemoryBatch` wrappers (intake.js)
// AND by saveAvatar() (processing.js) — one implementation, so "is this HEIC"
// and "how do we convert it" are each decided in exactly one place regardless
// of which upload path it came in on.
//
// Also owns resolveUploadedFile in full — not just its HEIC arm. It is the
// post-storage upload-resolution step fileFilter (intake.js) cannot decide
// (fileFilter runs before any bytes are readable), and that includes the
// NON-HEIC arms too: sniffing a real jpeg/png/webp out of a mistyped upload
// (sniffImageType) and rejecting a file that matches no known signature at
// all. Those arms live here, not split into intake.js or a file of their
// own, because resolveUploadedFile is one decision tree whose HEIC check has
// to run first — every one of its hard cases (a lying Content-Type, a
// truncated container, a pixel-bomb) is a HEIC case, so the module that
// reasons about the hard cases is the module that owns the whole function.
'use strict';

const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');

const config = require('../../../config');
const rateLimit = require('../rate-limit');
const { withBoundedSlot } = require('../../utils/upload-concurrency');
const { Semaphore } = require('../../utils/semaphore');
const {
  MAX_HEIC_PIXELS,
  HEIC_OVERSIZE_MESSAGE,
  HEIC_RATE_LIMIT_MESSAGE,
  GUEST_SAFE_CONVERT_CODES,
  DISALLOWED_TYPE_MESSAGE,
  ALLOWED_MIME_TO_EXT,
  HEIC_FTYP_BRANDS,
  UPLOADS_DIR,
} = require('./constants');
const { randomFilename, safeUploadPath } = require('./naming');

// ---------------------------------------------------------------------------
// HEIC detection + conversion. See the file header above for ownership and
// the disk-storage (intake.js) / avatar (processing.js) sharing rationale.
// ---------------------------------------------------------------------------

/**
 * Sniff whether a buffer's leading bytes are a HEIC/HEIF file, by its
 * ISO-BMFF `ftyp` box major brand — NOT by its declared mimetype. This is
 * the single source of truth for "is this HEIC": phones' camera apps declare
 * image/heic honestly, but the iOS/Android "Files" picker (and some
 * third-party browsers) hand over the same bytes under the generic
 * application/octet-stream mimetype (see intake.js's fileFilter and AC3).
 *
 * ISO-BMFF layout: bytes 0-3 are the box size (unused here), bytes 4-7 are
 * the ASCII box type ("ftyp" for the first box of a HEIC/HEIF/AVIF file),
 * bytes 8-11 are the ASCII major brand.
 *
 * @param {Buffer} buffer - at least the file's first 12 bytes.
 * @returns {boolean}
 */
function looksLikeHeic(buffer) {
  if (!buffer || buffer.length < 12) return false;
  if (buffer.toString('ascii', 4, 8) !== 'ftyp') return false;
  return HEIC_FTYP_BRANDS.has(buffer.toString('ascii', 8, 12));
}

// Magic-byte signatures for the three real image formats this app stores
// as-is (never HEIC — that is converted, handled separately above). Each
// `test` reads only the leading bytes already available in
// resolveUploadedFile's 12-byte header buffer (issue #933): JPEG needs 3,
// PNG needs 8, WebP needs bytes 0-3 and 8-11 (all within the first 12).
// Order is irrelevant — the three signatures cannot collide with each other
// or with a HEIC ftyp box.
const IMAGE_SNIFFERS = [
  {
    mimetype: 'image/jpeg',
    test: (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    mimetype: 'image/png',
    test: (b) => b.length >= 8 && b.toString('hex', 0, 8) === '89504e470d0a1a0a',
  },
  {
    mimetype: 'image/webp',
    test: (b) =>
      b.length >= 12 &&
      b.toString('ascii', 0, 4) === 'RIFF' &&
      b.toString('ascii', 8, 12) === 'WEBP',
  },
];

/**
 * Sniff whether a buffer's leading bytes are a real JPEG, PNG, or WebP file
 * — NOT by declared mimetype. This is `looksLikeHeic`'s sniff-the-bytes
 * approach applied to the three formats we store untouched, for the case a
 * real image arrives under a generic declared type (issue #933):
 * `application/octet-stream` is the case that matters in practice — Android
 * SAF content pickers (Drive, Files, some WebViews), and the HTML multipart
 * algorithm itself whenever `File.type` is empty, both send that generic
 * type for a real photo. `resolveUploadedFile` calls this ONLY when the
 * declared mimetype does not already map via ALLOWED_MIME_TO_EXT and the
 * bytes did not sniff as HEIC — a file that already declares an allowed
 * mimetype is trusted as today (sniffing every upload is separate scope; see
 * the issue's non-goals).
 *
 * @param {Buffer} buffer - at least the file's first 12 bytes.
 * @returns {{mimetype: string}|null} the mimetype to re-type the file as
 *          (the caller derives the extension via ALLOWED_MIME_TO_EXT, the
 *          one place that mapping lives), or null if the bytes match none of
 *          the three (a genuinely disallowed file, e.g. a PDF).
 */
function sniffImageType(buffer) {
  if (!buffer) return null;
  for (const sniffer of IMAGE_SNIFFERS) {
    if (sniffer.test(buffer)) return { mimetype: sniffer.mimetype };
  }
  return null;
}

/**
 * Read a HEIC/HEIF file's DECLARED pixel dimensions from its ISO-BMFF `ispe`
 * (image spatial extent) box, WITHOUT decoding a single pixel. This is the
 * cheap header value that the decoder's full-frame allocation is sized from,
 * so it is what the pixel-bomb cap (MAX_HEIC_PIXELS) must be checked against
 * before the decoder ever runs.
 *
 * An `ispe` box is exactly 20 bytes:
 *   size(4) = 20 | type(4) = 'ispe' | version+flags(4) | width(4) | height(4)
 * A file may carry more than one (a tiled/grid image has an `ispe` for the
 * assembled grid AND one per tile); the assembled grid's is the largest, and
 * it is the size the primary-image allocation uses, so we return the
 * LARGEST-area box found. The `size == 20` check rejects a coincidental
 * "ispe" byte sequence inside compressed image data.
 *
 * Verified against the actual decode path: heic-convert -> heic-decode
 * (node_modules/heic-decode/lib.js) allocates `width*height*4` from
 * libheif's get_width()/get_height(). libheif applies the spatial transforms
 * (`clap` crop, `irot`/`imir` — all area-preserving or shrinking) during
 * decode, so the `ispe` extent is a sound UPPER BOUND on that allocation:
 * gating on `ispe` area guarantees the real allocation is no larger.
 *
 * @param {Buffer} buffer - the HEIC file bytes.
 * @returns {{width: number, height: number}|null} largest declared extent, or
 *          null if no valid `ispe` box is present.
 */
function heicPixelDimensions(buffer) {
  if (!buffer || buffer.length < 20) return null;
  const marker = Buffer.from('ispe', 'ascii');
  let best = null;
  let from = 0;
  for (;;) {
    const t = buffer.indexOf(marker, from);
    if (t < 0) break;
    from = t + 4;
    if (t - 4 < 0 || t + 16 > buffer.length) continue;
    if (buffer.readUInt32BE(t - 4) !== 20) continue; // not a real 20-byte ispe box
    const width = buffer.readUInt32BE(t + 8);
    const height = buffer.readUInt32BE(t + 12);
    if (!best || width * height > best.width * best.height) {
      best = { width, height };
    }
  }
  return best;
}

/**
 * Reject a HEIC whose declared pixel area exceeds MAX_HEIC_PIXELS, or whose
 * dimensions cannot be read at all — BEFORE any decode allocates a raw frame.
 * A real HEIC always carries an `ispe` box; a HEIC-signatured file with no
 * readable extent cannot have its allocation bounded, so it is refused rather
 * than handed to the decoder. Throws the same BAD_IMAGE_TYPE error shape the
 * type-rejection paths use, with guest-safe copy.
 *
 * @param {Buffer} buffer - HEIC bytes (caller has confirmed looksLikeHeic).
 */
function assertHeicPixelsWithinCap(buffer) {
  const dims = heicPixelDimensions(buffer);
  if (!dims || dims.width * dims.height > MAX_HEIC_PIXELS) {
    const err = new Error(HEIC_OVERSIZE_MESSAGE);
    err.code = 'BAD_IMAGE_TYPE';
    throw err;
  }
}

/**
 * Charge a HEIC decode to a guest's per-guest decode budget and reject if it is
 * over the limit — the single enforcement point for the HEIC-decode rate limit
 * (issue #281), called by ALL three HEIC entry paths (resolveUploadedFile for
 * task submit + memory batch, and saveAvatar) BEFORE convertHeicToJpeg spawns a
 * worker, so an over-limit guest never triggers a decode. Only reached for
 * files that already sniff as HEIC, so JPEG/PNG/WebP uploads never consume this
 * budget.
 *
 * Fails CLOSED on an absent guest id: every real HEIC upload runs behind
 * attachGuest/requireGuest (disk paths) or is handed an explicit guest id
 * (avatar), so a missing id here is anomalous — refuse rather than allow an
 * unthrottled, unattributable decode. (The `guestId == null` check
 * short-circuits, so a missing id does not consume a budget slot.)
 *
 * @param {number|null|undefined} guestId
 * @throws {Error} with .code 'HEIC_RATE_LIMITED' when absent or over the limit.
 */
function assertHeicDecodeAllowed(guestId) {
  if (guestId == null || !rateLimit.recordHeicDecodeAttempt(guestId).allowed) {
    const err = new Error(HEIC_RATE_LIMIT_MESSAGE);
    err.code = 'HEIC_RATE_LIMITED';
    throw err;
  }
}

// Serializes HEIC decodes to at MOST ONE concurrent decode (#930), using the
// repo's existing, audited Semaphore primitive (src/utils/semaphore.js, the
// same primitive withUploadSlot/withAvatarSlot already standardize on,
// src/utils/upload-concurrency.js). The decode itself runs in a worker thread
// (see decodeHeicInWorker / heic-worker.js), so this bounds how many WORKERS
// run at once to one: a single decode transiently wants a few hundred MB of
// raw frame, and letting a reception-night burst of iPhone HEIC uploads stack
// up concurrent worker decodes could OOM the small (~2 GB) host this app is
// sized for. See DESIGN.md's convert-at-intake decision record for the number
// and the hosting context.
//
// The Semaphore's FIFO wait queue supports AbortSignal cancellation with
// identity-splice removal (semaphore.js's own comment on the splice at queue
// removal): a cancelled waiter is spliced out by identity, never tombstoned,
// so a slot can never leak and no separate counter needs a manual decrement —
// this is what makes the HEIC_QUEUE_WAIT_MS wait bound in convertHeicToJpeg
// below safe. Total occupancy (queued + in-flight) across ALL guests is
// `heicDecodeSemaphore.occupancy`; convertHeicToJpeg (via
// src/utils/upload-concurrency.js's withBoundedSlot) admits a decode only
// while that is below config.MAX_PENDING_HEIC_DECODES — see DESIGN.md's
// "Global pending-decode cap and admission" entry for the honest held-memory
// arithmetic this ceiling is sized against (it differs by caller kind: a
// disk caller's queued wait is cheap, an avatar caller's is not).
//
// Exported below (module.exports) so tests can observe .active/.pending/
// .occupancy directly — the same "import the live singleton" pattern
// tests/memories.test.js uses for src/utils/upload-concurrency.js's
// uploadSemaphore.
const heicDecodeSemaphore = new Semaphore(1);

// Absolute path to the worker module, resolved once. __dirname is this file's
// directory (src/services/photos), and heic-worker.js lives one directory up
// at src/services/heic-worker.js — it did NOT move in the #979 split, only
// this resolution changed to account for heic.js's new directory.
// HEIC_WORKER_PATH is a TEST SEAM (read once at load): tests point it at a
// controllable worker — e.g. one that hangs on a sentinel input — to exercise
// the decode timeout deterministically without a real pathological bitstream.
// Unset in production, it resolves to the real worker one directory up.
const HEIC_WORKER_PATH = process.env.HEIC_WORKER_PATH
  ? path.resolve(process.env.HEIC_WORKER_PATH)
  : path.join(__dirname, '..', 'heic-worker.js');

// Hard wall-clock ceiling on a single HEIC decode. The pixel cap
// (MAX_HEIC_PIXELS) bounds how much a decode allocates, but NOT how long it
// runs: a crafted HEIC with a small ispe (well under the cap) can carry a
// pathological HEVC bitstream that drives libheif into a non-terminating or
// extreme-slow decode. Without a timeout the worker would post no message and
// never exit, so decodeHeicInWorker would never settle — and because
// heicDecodeSemaphore (the single global serialization point) only advances
// past a held slot on release, EVERY subsequent HEIC upload would queue
// behind a decode that never settles: a process-wide denial of the HEIC path
// (the iPhone default) until a restart. This bound turns that hang into a
// per-request failure that also frees the slot for the next upload. 20s: a
// legitimate large HEIC decodes in
// ~1-3s, so this is generous headroom for a slow host while still bounding a
// hang to something a guest and the event loop can absorb. Overridable via
// HEIC_DECODE_TIMEOUT_MS (read once at load) so tests can drive the timeout
// deterministically without waiting the full 20s.
const HEIC_DECODE_TIMEOUT_MS = Number(process.env.HEIC_DECODE_TIMEOUT_MS) || 20000;

/**
 * Decode one HEIC buffer to JPEG in a FRESH worker_threads worker (spawned per
 * decode, then terminated), so the synchronous libheif decode never blocks the
 * main event loop and its large frame allocation is isolated in a short-lived
 * process. Per-decode spawn (rather than a long-lived pooled worker) is the
 * deliberate choice here: the worker exits after one image so its WASM heap +
 * raw frame are fully reclaimed each time and a worst-case decode cannot leak
 * or OOM the main app; the ~100–300ms spawn/WASM-init cost is acceptable for a
 * wedding's occasional, already-serialized HEIC uploads.
 *
 * Bounded by HEIC_DECODE_TIMEOUT_MS: a decode that never completes (a
 * pathological bitstream that hangs libheif) is force-failed and the worker
 * terminated, so it cannot wedge heicDecodeSemaphore for every later upload.
 *
 * Always terminates the worker (success or failure or timeout) so none leak.
 * Any failure — a worker 'error', a decode error posted back, an exit before a
 * result, or the timeout — rejects with a plain Error; the caller
 * (resolveUploadedFile / saveAvatar) maps that to the guest-safe BAD_IMAGE_TYPE
 * "couldn't be read" shape. A worker crash or hang therefore never crashes or
 * hangs the main process.
 *
 * @param {Buffer} buffer - real HEIC/HEIF bytes (already pixel-capped).
 * @returns {Promise<Buffer>} JPEG-encoded bytes.
 */
function decodeHeicInWorker(buffer) {
  return new Promise((resolve, reject) => {
    let settled = false;
    // Pass the pixel cap so the worker can gate on libheif's AUTHORITATIVE
    // dimensions before allocating the raster (the ispe pre-check on the main
    // thread is only a first-line filter — see MAX_HEIC_PIXELS).
    const worker = new Worker(HEIC_WORKER_PATH, {
      workerData: { buffer: buffer, maxPixels: MAX_HEIC_PIXELS },
    });

    const settle = (fn, arg) => {
      // Single-settle guard against a race between the message/error/exit/timeout
      // triggers. In practice the FIRST trigger calls removeAllListeners +
      // clearTimeout before a second can fire, so the `settled` true arm is a
      // defensive backstop with no deterministic trigger to test.
      /* v8 ignore next */
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      // terminate() is idempotent and safe on an already-exited worker; swallow
      // its promise so a rejection there is never unhandled. On a timeout this
      // is what kills a still-running (possibly hung) worker so it can't linger.
      worker.terminate().catch(() => {});
      fn(arg);
    };

    const timer = setTimeout(() => {
      settle(reject, new Error('HEIC decode timed out after ' + HEIC_DECODE_TIMEOUT_MS + 'ms'));
    }, HEIC_DECODE_TIMEOUT_MS);
    // Do not let a pending decode-timeout timer keep the process (or a vitest
    // run) alive on its own; the worker + listeners are what matter.
    // The false arm is unreachable in this Node runtime — setTimeout always
    // returns a Timeout with .unref(); the typeof guard is defensive only.
    /* v8 ignore next */
    if (typeof timer.unref === 'function') timer.unref();

    worker.on('message', (msg) => {
      if (msg && msg.ok) {
        settle(resolve, Buffer.from(msg.buffer));
      } else if (msg && msg.oversize) {
        // The worker's authoritative gate rejected the image by libheif's real
        // get_width/get_height BEFORE the raster was allocated. Surface the same
        // guest-safe oversize BAD_IMAGE_TYPE the main-thread ispe pre-check uses.
        const err = new Error(HEIC_OVERSIZE_MESSAGE);
        err.code = 'BAD_IMAGE_TYPE';
        settle(reject, err);
      } else {
        settle(reject, new Error((msg && msg.message) || 'HEIC decode failed in worker'));
      }
    });
    worker.on('error', (err) => settle(reject, err));
    // Any exit BEFORE a message settled us (non-zero crash, or the pathological
    // zero-exit-without-result) is a failure — reject rather than hang.
    worker.on('exit', (code) =>
      settle(reject, new Error('HEIC decode worker exited without a result (code ' + code + ')'))
    );
  });
}

/**
 * Build the guest-safe HEIC_RATE_LIMITED error convertHeicToJpeg throws both
 * at admission (ceiling reached) and at wait-expiry (HEIC_QUEUE_WAIT_MS
 * elapsed) — single owner of that error's shape so the two throw sites (and
 * any future one) cannot drift apart in code/message.
 * @returns {Error}
 */
function heicRateLimitedError() {
  const err = new Error(HEIC_RATE_LIMIT_MESSAGE);
  err.code = 'HEIC_RATE_LIMITED';
  return err;
}

/**
 * Stage-1 pixel-bomb check: read whatever dimensions the SNIFF PREFIX (not
 * the full file) exposes, and report whether stage 2 (the full-buffer check,
 * after the buffer is actually available) is still needed. This is a "does
 * stage 2 still need to run" verdict, not an admission decision — a `true`
 * return does not mean the HEIC is admitted, only that this stage alone
 * cannot rule it out either way.
 *
 * - A trustworthy over-cap `ispe` in the prefix rejects HERE, synchronously,
 *   before any slot is acquired — the admission-stage "costs no slot" case
 *   the issue describes for a normally-muxed HEIC (leading `meta` box).
 * - A within-cap `ispe` in the prefix is NOT trusted on its own when
 *   `prefixTruncated` is true — the CALLER'S OWN knowledge that `prefix` is
 *   shorter than the real file (a partial `ipco` can surface only a small
 *   tile's `ispe`, so a within-cap answer from a truncated read is not
 *   authoritative): stage 2 still runs on the full buffer.
 * - No `ispe` at all in the prefix is legal ISO-BMFF (a late `meta` box) —
 *   inconclusive, not a rejection; stage 2 decides.
 *
 * @param {Buffer} prefix - the admission-time sniff bytes (disk path: a
 *        positioned fs.readSync(fd, buf, 0, N, 0); avatar path: a subarray
 *        of the in-RAM buffer).
 * @param {boolean} prefixTruncated - true when the CALLER already knows
 *        `prefix` is shorter than the real file (disk: `sniffBytesRead ===
 *        HEIC_ADMISSION_SNIFF_BYTES`; avatar: `buffer.length >
 *        HEIC_ADMISSION_SNIFF_BYTES`) — stated by the producer that already
 *        has this fact, not re-derived here from `prefix.length` (which
 *        cannot distinguish "the file is exactly this long" from "the file
 *        is longer and this is a cut prefix").
 * @returns {boolean} true if stage 2 (full-buffer assertHeicPixelsWithinCap)
 *          must still run once the full buffer is available.
 * @throws {Error} .code 'BAD_IMAGE_TYPE' if the prefix's own `ispe` is
 *         already, trustworthily, over MAX_HEIC_PIXELS.
 */
function heicPrefixNeedsFullCheck(prefix, prefixTruncated) {
  const dims = heicPixelDimensions(prefix);
  if (!dims) {
    return true; // no ispe in the prefix yet -- inconclusive, defer to stage 2
  }
  if (dims.width * dims.height > MAX_HEIC_PIXELS) {
    const err = new Error(HEIC_OVERSIZE_MESSAGE);
    err.code = 'BAD_IMAGE_TYPE';
    throw err;
  }
  // Within cap by the prefix's own ispe -- still needs stage 2 if the caller
  // knows this prefix might have been truncated (a larger file could carry a
  // different ispe, e.g. an assembled-grid tile, beyond what the prefix covered).
  return prefixTruncated;
}

/**
 * Convert a HEIC/HEIF buffer to a JPEG buffer, admitted through
 * heicDecodeSemaphore via src/utils/upload-concurrency.js's withBoundedSlot
 * (issue #930 round-2 review: the HEIC gate and the avatar gate are now both
 * thin callers of that one shared "ceiling check -> acquire -> timeout-recode
 * -> run -> release" primitive, replacing two independently hand-rolled
 * copies of the same shape).
 *
 * `header` is `{ prefix, prefixTruncated }` — the admission-time SNIFF
 * PREFIX (NOT the full file) plus whether the CALLER already knows that
 * prefix was cut short of the real file. Disk callers pass `sniffBytesRead
 * === HEIC_ADMISSION_SNIFF_BYTES` from resolveUploadedFile's positioned
 * fs.readSync; avatar callers pass `buffer.length > HEIC_ADMISSION_SNIFF_BYTES`
 * from their in-RAM buffer — the producer states the truth it already has,
 * rather than heicPrefixNeedsFullCheck re-deriving it from `prefix.length`.
 *
 * `supplier` is a zero-argument function that returns (or resolves to) the
 * FULL buffer; it is called ONLY after a decode slot is actually granted.
 * For a DISK caller (task submit, memory batch) this genuinely defers the
 * full-file read: queued behind a busy semaphore, it has not yet read (and
 * does not pin) its MAX_UPLOAD_BYTES buffer. For the AVATAR caller there is
 * nothing to defer — the full buffer is already resident in RAM before this
 * function is ever called, so an avatar decode pins its full buffer for the
 * whole queued wait regardless of this pattern. See DESIGN.md's "Global
 * pending-decode cap and admission" entry for the honest arithmetic this
 * asymmetry produces and what actually licenses MAX_PENDING_HEIC_DECODES.
 *
 * heicPrefixNeedsFullCheck runs on just the prefix, before any slot is ever
 * requested, and may throw synchronously on a trustworthy over-cap prefix,
 * or flag that stage 2 (assertHeicPixelsWithinCap on the full buffer) must
 * still run once the full buffer is available — still before
 * decodeHeicInWorker either way, so an over-cap file NEVER spawns a worker
 * regardless of which stage catches it. This call and withBoundedSlot's own
 * ceiling check + acquire() happen in ONE synchronous turn (no `await`
 * between them) — an async gap here would open a check-then-enqueue race
 * that could admit a decode past the ceiling. A cancelled/expired wait is
 * spliced out of the semaphore's queue by identity (semaphore.js) — it never
 * held a slot, so expiry never reads `supplier` and never leaves a slot to
 * release.
 *
 * The GLOBAL pending-decode ceiling this enforces is separate from the
 * PER-GUEST decode-rate limit (assertHeicDecodeAllowed), which runs upstream
 * in resolveUploadedFile/saveAvatar before this function is ever called.
 *
 * @param {{prefix: Buffer, prefixTruncated: boolean}} header
 * @param {() => (Buffer|Promise<Buffer>)} supplier - returns the full HEIC
 *        buffer; invoked only after a decode slot is granted.
 * @returns {Promise<Buffer>} JPEG-encoded bytes.
 * @throws {Error} synchronously with .code 'BAD_IMAGE_TYPE' if the prefix's
 *         own declared pixel area exceeds MAX_HEIC_PIXELS. Asynchronously
 *         (via the returned Promise) with .code 'HEIC_RATE_LIMITED' if the
 *         global pending-decode ceiling is already reached (withBoundedSlot
 *         is async, so its pre-acquire ceiling throw surfaces as a
 *         rejection) or if the wait bound (HEIC_QUEUE_WAIT_MS) expires
 *         before a slot frees; with 'BAD_IMAGE_TYPE' if the full buffer
 *         turns out oversized/unreadable.
 */
function convertHeicToJpeg({ prefix, prefixTruncated }, supplier) {
  // SECURITY: bound the decoder's raw-frame allocation by the file's
  // declared dimensions, cheaply, on just the prefix, before a worker is
  // ever spawned (and before withBoundedSlot's own ceiling check/acquire, in
  // this same synchronous turn — see this function's own doc comment).
  const needsStage2Check = heicPrefixNeedsFullCheck(prefix, prefixTruncated);

  return withBoundedSlot(
    heicDecodeSemaphore,
    {
      limitKind: 'occupancy',
      limit: config.MAX_PENDING_HEIC_DECODES,
      waitMs: config.HEIC_QUEUE_WAIT_MS,
      busyError: heicRateLimitedError,
      // Same guest-facing code/copy as a ceiling refusal, but keep the
      // underlying TimeoutError as the cause so logs can tell an instant
      // ceiling refusal from a 45s wait expiry (a distinct loss path).
      timeoutError: (waitErr) => Object.assign(heicRateLimitedError(), { cause: waitErr }),
    },
    async () => {
      const buffer = await supplier();
      if (needsStage2Check) {
        // SECURITY: the authoritative pre-worker check on the FULL buffer,
        // still before decodeHeicInWorker — an over-cap file caught here
        // never spawns a worker either.
        assertHeicPixelsWithinCap(buffer);
      }
      return await decodeHeicInWorker(buffer);
    }
  );
}

/**
 * Finish what intake.js's fileFilter could not decide: given a multer disk-storage
 * file descriptor that has ALREADY been written to disk, resolve it into
 * exactly what the rest of the app expects to find there.
 *
 * The SIGNATURE is the single source of truth for "is this HEIC" — we always
 * sniff the leading bytes FIRST, before trusting the declared mimetype, so a
 * real HEIC that lies about its Content-Type (e.g. a picker that stamps
 * image/jpeg onto HEVC bytes) is still caught and converted rather than stored
 * as an undecodable `.jpg` that makeThumb would then choke on. This matches
 * saveAvatar, which also runs looksLikeHeic unconditionally.
 *
 *   - Bytes sniff as HEIC (looksLikeHeic) -> convert to JPEG, write the JPEG
 *     under a fresh randomFilename('.jpg'), delete the original bytes, and
 *     mutate `file` in place (.filename, .path, .mimetype) so the caller's
 *     req.file/req.files entry — and everything downstream that reads it
 *     (submissions.js, makeThumb) — sees the JPEG that is actually on disk
 *     now. This regardless of the declared mimetype. This is what makes HEIC
 *     invisible to src/routes/guest.js: the route never sees a difference
 *     between a native JPEG upload and a converted one.
 *   - Not HEIC, and the declared mimetype IS a real allowed type
 *     (jpeg/png/webp) -> nothing to do; diskStorage's filename() already gave
 *     it the right extension and the file is correctly stored.
 *   - Not HEIC, declared mimetype not allowed, but the bytes sniff as
 *     jpeg/png/webp (sniffImageType) -> rename to the sniffed extension and
 *     re-type file.mimetype; kept, not rejected.
 *   - Not HEIC, and the declared mimetype is NOT a real allowed type AND the
 *     bytes do not sniff as jpeg/png/webp either (the octet-stream /
 *     HEIC-candidate that turned out to be a lie or a corrupt/unsupported
 *     file) is rejected here with the same BAD_IMAGE_TYPE shape fileFilter
 *     uses.
 *
 * Deletes the file itself on rejection/conversion-failure; does NOT clean up
 * any OTHER file in a multi-file batch — callers with more than one file
 * (uploadMemoryBatch) are responsible for that.
 *
 * @param {{filename: string, path: string, mimetype: string}} file - multer's
 *        disk-storage descriptor; mutated in place on a HEIC conversion or a
 *        sniff re-type.
 * @param {number|null|undefined} guestId - the uploading guest (from
 *        res.locals.guest.id). Used ONLY to charge the per-guest HEIC-decode
 *        rate limit, and only when the file actually sniffs as HEIC.
 * @returns {Promise<void>}
 */
async function resolveUploadedFile(file, guestId) {
  // Derive the on-disk path from a VALIDATED basename inside the fixed
  // UPLOADS_DIR, rather than trusting the multer descriptor's tainted
  // `.path`/`.filename` in any fs call. multer's diskStorage already sets the
  // name from randomFilename() and the dir to UPLOADS_DIR, so this cannot
  // traverse — deriving through safeUploadPath makes that provable to a reader
  // and to static analysis, and fails closed if the invariant is ever violated
  // upstream. No fs operation below touches file.path/file.filename directly.
  const safePath = safeUploadPath(file.filename);
  // Fail-closed backstop: multer's diskStorage always names files via
  // randomFilename() (storage-shaped), so safeUploadPath never returns null for
  // a real upload — this arm has no reachable trigger in normal flow and is a
  // defense-in-depth guard (safeUploadPath itself is unit-tested both ways).
  /* v8 ignore next 8 */
  if (!safePath) {
    // Not a name our own storage layer could have produced. Fail closed WITHOUT
    // any fs op on the tainted descriptor path — if the name is not
    // storage-shaped, multer did not write a file under it in UPLOADS_DIR, so
    // there is nothing safe (or necessary) to unlink.
    const err = new Error(DISALLOWED_TYPE_MESSAGE);
    err.code = 'BAD_IMAGE_TYPE';
    throw err;
  }

  // Open the stored file EXACTLY ONCE and do both the bounded 12-byte header
  // sniff and — only on the HEIC-confirmed branch — the full read through this
  // SAME file descriptor. Reading through an already-open fd pins both reads to
  // one inode, so the path is never re-resolved between the check (sniff) and
  // the use (full read): that closes the check-then-use (TOCTOU) race a
  // separate open-to-sniff + reopen-to-read would leave (CodeQL
  // js/file-system-race).
  //
  // The dominant case is non-HEIC, where nothing downstream ever needs the rest
  // of the bytes (sharp re-reads the file from disk for the thumbnail), so a
  // full-file read on every upload would be pure waste — up to MAX_UPLOAD_BYTES
  // (15 MB) copied into memory on the main thread for a 12-byte decision. The
  // full read therefore happens ONLY inside the HEIC-confirmed branch below,
  // where convertHeicToJpeg actually needs every byte.
  const header = Buffer.alloc(12);
  const fd = fs.openSync(safePath, 'r');
  try {
    // Sniff at an EXPLICIT position 0, which leaves the fd's own read offset
    // UNCHANGED (Node fs semantics, confirmed on this runtime) — so a later
    // fs.readFileSync(fd) on the HEIC branch still starts at byte 0 and returns
    // the whole file, leading 12 bytes included.
    const headerBytesRead = fs.readSync(fd, header, 0, 12, 0);

    if (!looksLikeHeic(header.subarray(0, headerBytesRead))) {
      // Not HEIC. Keep it only if its declared type is one we actually store;
      // otherwise it is a non-HEIC file that only got this far because fileFilter
      // accepted its mimetype provisionally (e.g. application/octet-stream).
      if (ALLOWED_MIME_TO_EXT[file.mimetype]) {
        return; // already a real, correctly-stored jpeg/png/webp — nothing to do
      }

      // The declared type didn't map directly (a HEIC candidate that turned
      // out not to be HEIC — almost always application/octet-stream). Before
      // rejecting outright, sniff the same 12-byte header for a real
      // jpeg/png/webp signature (issue #933): Android SAF pickers, and the
      // HTML multipart algorithm itself when `File.type` is empty, both hand
      // over a genuine photo under this generic type. On a match, RENAME
      // (not copy — the bytes are already correct, only the provisional
      // `.heic` disk name and the declared mimetype are wrong) the stored
      // file to a properly-extensioned name and re-type file.mimetype,
      // mirroring the HEIC conversion branch below so a route/thumbnailer
      // reading req.file afterward sees a consistent, correctly-named file.
      const sniffed = sniffImageType(header.subarray(0, headerBytesRead));
      if (sniffed) {
        const newName = randomFilename(ALLOWED_MIME_TO_EXT[sniffed.mimetype]);
        const newPath = path.join(UPLOADS_DIR, newName);
        fs.renameSync(safePath, newPath);
        file.filename = newName;
        file.path = newPath;
        file.mimetype = sniffed.mimetype;
        return;
      }

      // No signature matched (jpeg/png/webp/heic all ruled out) — a
      // genuinely disallowed file (e.g. a PDF) that only reached here by
      // declaring a HEIC-candidate mimetype. The gate does not widen to
      // arbitrary bytes.
      fs.unlinkSync(safePath);
      const err = new Error(DISALLOWED_TYPE_MESSAGE);
      err.code = 'BAD_IMAGE_TYPE';
      throw err;
    }

    // HEIC confirmed by signature. Charge the per-guest decode rate limit BEFORE
    // spending a decode; an over-limit (or unattributable) guest is rejected here
    // without the file ever reaching the worker. Delete the stored file first so a
    // rejected upload leaves no residue (same as the reject branches above).
    try {
      assertHeicDecodeAllowed(guestId);
    } catch (rlErr) {
      fs.unlinkSync(safePath);
      throw rlErr;
    }

    // Admission-stage sniff: a SECOND positioned read from the SAME fd (no
    // re-open — the single-openSync TOCTOU guard above is preserved), this
    // time up to HEIC_ADMISSION_SNIFF_BYTES so convertHeicToJpeg's stage-1
    // pixel check has real bytes to look at BEFORE a decode slot is ever
    // requested. Explicit position 0 (same reasoning as the 12-byte sniff
    // above) leaves the fd's read offset unchanged. fs.readSync (NOT
    // fs.readFileSync, which takes no length and reads from the current
    // offset) is what makes this a bounded, positioned read rather than an
    // unconditional full-file read on every HEIC candidate.
    const sniffBuf = Buffer.alloc(config.HEIC_ADMISSION_SNIFF_BYTES);
    const sniffBytesRead = fs.readSync(fd, sniffBuf, 0, config.HEIC_ADMISSION_SNIFF_BYTES, 0);
    const admissionPrefix = sniffBuf.subarray(0, sniffBytesRead);
    // True exactly when this positioned read filled the whole sniff buffer —
    // the file may well continue past it, so the prefix cannot be trusted as
    // the whole story (see heicPrefixNeedsFullCheck's own doc comment on
    // prefixTruncated). A short read (sniffBytesRead < the buffer size) means
    // the file itself ended within the prefix, so there is nothing beyond it.
    const admissionPrefixTruncated = sniffBytesRead === config.HEIC_ADMISSION_SNIFF_BYTES;

    // The FULL file (bounded by MAX_UPLOAD_BYTES = 15 MB) is read ONLY once a
    // decode slot is actually granted — convertHeicToJpeg calls this supplier
    // itself, after heicDecodeSemaphore.acquire() resolves, so a caller
    // queued behind a busy semaphore never pins this buffer while merely
    // waiting (issue #930). Passing the fd (not the path) is what keeps this
    // pinned to the inode the sniff already validated. This is the only
    // full-file read on this path, and it happens at most once regardless of
    // how long the wait was.
    let jpegBuffer;
    try {
      jpegBuffer = await convertHeicToJpeg(
        { prefix: admissionPrefix, prefixTruncated: admissionPrefixTruncated },
        () => fs.readFileSync(fd)
      );
    } catch (convertErr) {
      fs.unlinkSync(safePath);
      // convertHeicToJpeg's own guards throw already-guest-safe, coded errors
      // (BAD_IMAGE_TYPE for the pixel cap, HEIC_RATE_LIMITED for the global
      // pending cap) — let those through with their specific message rather than
      // masking it. Only a genuine decode failure (an uncoded raw libheif error,
      // a timeout, or a worker-infrastructure error) gets the generic copy.
      if (GUEST_SAFE_CONVERT_CODES.has(convertErr.code)) {
        throw convertErr;
      }
      const err = new Error("Sorry, that photo couldn't be read. Please try a different photo.", {
        cause: convertErr,
      });
      err.code = 'BAD_IMAGE_TYPE';
      throw err;
    }

    const newName = randomFilename('.jpg');
    const newPath = path.join(UPLOADS_DIR, newName);
    fs.writeFileSync(newPath, jpegBuffer);
    fs.unlinkSync(safePath);

    file.filename = newName;
    file.path = newPath;
    file.mimetype = 'image/jpeg';
  } finally {
    // Close the single fd on EVERY exit: the non-HEIC early return, every throw
    // (bad-type, rate-limit, convert-failure), and the HEIC success path.
    // fs.readFileSync(fd) does not close a caller-supplied fd, so this is the
    // sole close and never double-closes.
    fs.closeSync(fd);
  }
}

module.exports = {
  looksLikeHeic,
  heicPixelDimensions,
  assertHeicPixelsWithinCap,
  assertHeicDecodeAllowed,
  heicDecodeSemaphore,
  convertHeicToJpeg,
  resolveUploadedFile,
};
