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
//   - Validate type (jpeg/png/webp/HEIC) and size (15 MB) with clear errors. HEIC/HEIF
//     is CONVERTED to JPEG at intake (issue #281, superseding #188's rejection) — see
//     the allowlist note below and the `upload`/`uploadMemoryBatch`/`saveAvatar` doc
//     comments for where the conversion actually happens.
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
const { Worker } = require('worker_threads');
const multer = require('multer');
const sharp = require('sharp');

const config = require('../../config');
const { db } = require('../db');
const scoring = require('./scoring');
const rateLimit = require('./rate-limit');
const { isAdminRequest } = require('../middleware/session');
const {
  withAvatarSlot,
  AVATAR_GATE_CODES,
  withBoundedSlot,
} = require('../utils/upload-concurrency');
const { Semaphore } = require('../utils/semaphore');

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

// Accepted upload MIME types -> the file extension we store the ORIGINAL
// under once it is a real, storable file. These are the only extensions any
// file in UPLOADS_DIR/THUMBS_DIR ever has: HEIC/HEIF is never one of them —
// it is converted to JPEG before it is ever inserted into the DB (see the
// `upload`/`uploadMemoryBatch`/`saveAvatar` doc comments below) because the
// prebuilt sharp binaries this app runs on cannot decode real iPhone/Samsung
// HEIC (their bundled libheif has only an AV1 decoder —
// sharp.format.heif.input.fileSuffix === ['.avif'] — HEVC is excluded for
// patent-licensing reasons). `heic-convert` (a pure-JS HEVC decoder, no
// native build) does the conversion instead; see DESIGN.md's convert-at-intake
// decision record for why and for the one-decode-at-a-time memory note.
const ALLOWED_MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg', // some browsers/devices report this non-standard value
  'image/pjpeg': '.jpg', // progressive JPEG variant some clients send
  'image/png': '.png',
  'image/webp': '.webp',
};

// Human-readable list for error messages.
const ALLOWED_LABEL = 'JPEG, PNG, or WebP';

// The single guest-facing "wrong type" rejection string, shared by the
// pre-storage `fileFilter` and the post-storage `resolveUploadedFile` (a HEIC
// candidate whose bytes turn out not to be HEIC is rejected there, not in
// fileFilter — see fileFilter's doc comment). One const so the two rejection
// points that must say the same thing cannot drift apart.
const DISALLOWED_TYPE_MESSAGE = `That file type is not allowed. Please upload a ${ALLOWED_LABEL} image.`;

// Guest-facing copy when a guest exceeds the per-guest HEIC-decode rate limit
// OR the global pending-decode cap is reached (issue #281). Distinct .code so
// it is not confused with a bad-type or too-many-files rejection; the routes
// flash err.message either way.
const HEIC_RATE_LIMIT_MESSAGE =
  "You're sharing photos faster than we can process them — give it a moment and try again.";

// Error .code values that convertHeicToJpeg's own guards raise and that already
// carry guest-safe copy — the HEIC callers pass these straight through instead
// of masking them as a generic "couldn't be read". Everything else (an uncoded
// raw libheif decode error, a timeout, or a Node worker-infrastructure error
// like ERR_WORKER_PATH) is NOT guest-safe and gets the generic message. Single
// owner of "which convert errors surface verbatim to the guest".
const GUEST_SAFE_CONVERT_CODES = new Set(['BAD_IMAGE_TYPE', 'HEIC_RATE_LIMITED']);

// Guest-facing copy for an over-MAX_HEIC_PIXELS image. Single owner, shared by
// the cheap main-thread ispe pre-check (assertHeicPixelsWithinCap) and the
// authoritative worker gate's oversize mapping (decodeHeicInWorker), so both
// oversize rejections say the same thing.
const HEIC_OVERSIZE_MESSAGE =
  "That photo's resolution is too large to process here. Please try a smaller photo.";

// Mimetypes a HEIC/HEIF file might plausibly declare. `fileFilter` accepts
// these PROVISIONALLY (multer's fileFilter runs before any bytes are
// readable — see the note above `fileFilter` below — so it cannot yet tell a
// real HEIC from a lie). `application/octet-stream` is in this set too: the
// iOS/Android "Files" picker (and some third-party browsers) send a real
// HEIC under that generic mimetype rather than image/heic — see
// `looksLikeHeic` and `resolveUploadedFile`, which do the real, signature-
// based decision once the file's bytes are available. `image/heic-sequence`
// and `image/heif-sequence` (issue #933) are the mimetypes Live Photos /
// HEIC burst sequences declare via the iOS/Android "Files" picker — see
// HEIC_FTYP_BRANDS' `hevc`/`hevx` entries below for the brands those
// containers actually carry.
const HEIC_CANDIDATE_MIMES = new Set([
  'image/heic',
  'image/heif',
  'image/heic-sequence',
  'image/heif-sequence',
  'application/octet-stream',
]);

// ISO-BMFF `ftyp` box major brands used by real HEIC/HEIF files. See
// `looksLikeHeic` below for how these are read from a file's leading bytes.
// `hevc`/`hevx` (issue #933) are the brands an `image/heic-sequence`
// container carries (node_modules/heic-decode/lib.js:13-20) — admitting that
// mimetype in HEIC_CANDIDATE_MIMES without also admitting its brands here
// would let the file past fileFilter only for looksLikeHeic to reject it
// after a full disk write.
const HEIC_FTYP_BRANDS = new Set(['heic', 'heix', 'heif', 'hevc', 'hevx', 'mif1', 'msf1']);

// Maximum decoded pixel area (width * height) we will attempt to convert from
// HEIC. This is a SECURITY cap against a HEIC "pixel bomb": heic-decode
// allocates a full raw RGBA frame — `new Uint8ClampedArray(width*height*4)`
// (node_modules/heic-decode/lib.js) — sized from libheif's decoded-image
// get_width()/get_height(), BEFORE sharp's own pixel guard ever runs. A crafted
// few-MB HEIC (a uniform/gradient image compresses tiny under HEVC, well within
// MAX_UPLOAD_BYTES) can carry huge dimensions and force a ~1 GB allocation that
// OOMs the ~2 GB host (see DESIGN.md's constraints). The jpeg/png/webp path is
// protected by sharp's default input-pixel guard; the HEIC path is not, because
// sharp only runs AFTER the decode has already allocated.
//
// This cap is enforced at TWO points (see DESIGN.md § "HEIC pixel-bomb cap uses
// libheif's authoritative dimensions"):
//   1. a cheap MAIN-THREAD pre-check on the ISO-BMFF `ispe` box
//      (assertHeicPixelsWithinCap / heicPixelDimensions) — rejects an honestly-
//      huge HEIC before a worker is even spawned; and
//   2. the AUTHORITATIVE check inside the worker (heic-worker.js) on libheif's
//      get_width()/get_height() AFTER container parse but BEFORE the raster
//      allocation — because empirically libheif does NOT size the allocation
//      from `ispe` (patching an `ispe` to huge dims leaves get_width unchanged;
//      a non-standard-size `ispe` makes libheif reject the file). The worker
//      gate is what actually bounds the allocation; the ispe pre-check is a
//      first-line filter that avoids spawning a worker for the honest case.
//
// 100 megapixels: comfortably above any default-camera phone HEIC (a 48 MP
// iPhone ProRAW frame, a 50 MP flagship, a 12 MP standard shot) with headroom,
// while a 100 MP RGBA decode is ~400 MB — the largest single transient the
// one-decode-at-a-time gate (heicDecodeSemaphore) permits, keeping well under the
// ~2 GB host alongside Node + SQLite + sharp. Deliberately TIGHTER than sharp's
// default limitInputPixels (~268 MP ≈ 1.07 GB RGBA) AND than libheif's own
// default max (~1 gigapixel), which this host cannot safely absorb. Overridable
// via MAX_HEIC_PIXELS (read once at load) so tests can drive the gate
// deterministically with a small cap.
const MAX_HEIC_PIXELS = Number(process.env.MAX_HEIC_PIXELS) || 100 * 1000 * 1000;

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
 * BAD_IMAGE_TYPE code and message this function used to produce directly —
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

// ---------------------------------------------------------------------------
// HEIC detection + conversion. Shared by the disk-storage `upload`/
// `uploadMemoryBatch` wrappers below AND by saveAvatar() (memory storage) —
// one implementation, so "is this HEIC" and "how do we convert it" are each
// decided in exactly one place regardless of which upload path it came in on.
// ---------------------------------------------------------------------------

/**
 * Sniff whether a buffer's leading bytes are a HEIC/HEIF file, by its
 * ISO-BMFF `ftyp` box major brand — NOT by its declared mimetype. This is
 * the single source of truth for "is this HEIC": phones' camera apps declare
 * image/heic honestly, but the iOS/Android "Files" picker (and some
 * third-party browsers) hand over the same bytes under the generic
 * application/octet-stream mimetype (see fileFilter above and AC3).
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

// Serializes HEIC decodes to at MOST ONE concurrent decode (issue #930:
// replaces the hand-rolled heicDecodeChain promise chain + pendingHeicDecodes
// counter this comment used to describe, with the repo's existing, audited
// Semaphore primitive — src/utils/semaphore.js, the same primitive
// withUploadSlot/withAvatarSlot already standardize on,
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
// directory (src/services), and heic-worker.js is a sibling. HEIC_WORKER_PATH
// is a TEST SEAM (read once at load): tests point it at a controllable worker
// — e.g. one that hangs on a sentinel input — to exercise the decode timeout
// deterministically without a real pathological bitstream. Unset in production,
// it resolves to the real sibling worker.
const HEIC_WORKER_PATH = process.env.HEIC_WORKER_PATH
  ? path.resolve(process.env.HEIC_WORKER_PATH)
  : path.join(__dirname, 'heic-worker.js');

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
 * Finish what fileFilter above could not decide: given a multer disk-storage
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
 * behind. That trust used to be earned by multer's own abort; it is earned
 * here instead, now that the HEIC decision happens after multer is done.
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
 * @returns {Promise<string|null>} the stored avatar filename (also written to
 *   guests.avatar_path), or null when the issue #929 avatar concurrency gate
 *   (withAvatarSlot) rejected this save with AVATAR_QUEUE_BUSY or
 *   AVATAR_SLOT_TIMEOUT. A gate rejection costs the guest nothing but the
 *   avatar itself (they can add one later from their profile), so it is
 *   deliberately NOT thrown here -- every other caller in this file that
 *   ever runs concurrently with saveAvatar (a task submit, a memory batch)
 *   must never be dragged down by one guest's avatar losing a race for a
 *   slot. Every OTHER failure (a corrupt/undecodable image, a HEIC decode
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

// ---------------------------------------------------------------------------
// Path / URL builders.
// submissions.photo_path and submissions.thumb_path (and guests.avatar_path) store
// the RELATIVE filename only (no directory). These helpers convert between filename,
// absolute disk path, and the public URL served by the static mounts in app.js.
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
// the guest who owns it" predicate (issue #886 PR review fix — the rule had
// been hand-typed independently at more than one call site, in mixed
// polarity). This codebase already had this exact duplicated-visibility-rule
// problem once — see src/services/feed.js's own file comment on why
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
// independently at more than one call site was a PR-review finding on issue
// #886 (both reviewers): a third attribution value added later that updates
// only one site would silently let a guest launder a non-guest takedown into
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
// Deliberately jpg/png/webp only, with no `.heic` variant (issue #281):
// resolveUploadedFile and saveAvatar convert every HEIC upload to JPEG before
// it is ever written under its final name, so a `.heic` file never reaches
// UPLOADS_DIR under a name matching this pattern — nothing to allowlist.
const ORIGINAL_RE = /^[0-9a-f]{16}-\d+\.(jpg|png|webp)$/i;

// Stored thumbnail filenames:  <16 hex chars>-<ms timestamp>.<ext>.jpg
// Same jpg/png/webp-only note as ORIGINAL_RE above applies to the embedded
// original extension here.
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
 * An authenticated admin (issue #191) bypasses the takedown 404 — moderation
 * needs to see what it is hiding in order to decide whether to restore it —
 * but still 404s a malformed/allowlist-failing path either way.
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

  // Admin bypass: an admin session sees taken-down files too (issue #191).
  if (isAdminRequest(req)) {
    return next();
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
 * Same admin bypass as blockTakenDownOriginal above (issue #191).
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

  // Admin bypass: an admin session sees taken-down files too (issue #191).
  if (isAdminRequest(req)) {
    return next();
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

  // HEIC pixel-bomb guard (exported for direct unit testing — see
  // tests/heic-conversion.test.js). MAX_HEIC_PIXELS is the single cap;
  // heicPixelDimensions reads declared dims from the `ispe` box without
  // decoding; assertHeicPixelsWithinCap is the throw-if-oversized gate.
  MAX_HEIC_PIXELS,
  heicPixelDimensions,
  assertHeicPixelsWithinCap,

  // The live HEIC-decode admission gate (issue #930) — exported so tests can
  // observe .active/.pending directly, the same "import the live singleton"
  // pattern tests/memories.test.js uses for
  // src/utils/upload-concurrency.js's uploadSemaphore.
  heicDecodeSemaphore,

  // safe-path derivation from a multer descriptor's filename (exported for
  // direct unit testing of both the allowlisted and fail-closed arms).
  safeUploadPath,

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
  // the single owner of the "hidden by the owning guest" predicate (issue
  // #886 PR review fix), and its composed "is this row sticky" predicate —
  // callers use these instead of each re-deriving the conjunction.
  hiddenByOwningGuest,
  isStickyTakedown,

  // destructive helpers
  hardDelete,
  deleteOriginalFile,
  deleteThumbFile,
};
