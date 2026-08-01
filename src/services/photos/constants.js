// src/services/photos/constants.js
// Photo-pipeline constants (issue #979 split). This file is the ONE place
// the photo-pipeline limits live, so the contract is not split across
// config.js and here. config.js only supplies UPLOADS_DIR/THUMBS_DIR (paths),
// which this file resolves; paths.js is what ensures they exist on disk.
// Values only — no side effects at load.
'use strict';

const path = require('path');

const config = require('../../../config');

// ---------------------------------------------------------------------------
// Constants.
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
// `upload`/`uploadMemoryBatch` doc comments in intake.js and `saveAvatar`'s
// in processing.js) because the prebuilt sharp binaries this app runs on
// cannot decode real iPhone/Samsung HEIC (their bundled libheif has only an
// AV1 decoder — sharp.format.heif.input.fileSuffix === ['.avif'] — HEVC is
// excluded for patent-licensing reasons). `heic-convert` (a pure-JS HEVC
// decoder, no native build) does the conversion instead; see DESIGN.md's
// convert-at-intake decision record for why and for the one-decode-at-a-time
// memory note.
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
// readable — see fileFilter's own note in intake.js — so it cannot yet tell a
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
// heic.js's `looksLikeHeic` for how these are read from a file's leading bytes.
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
// Resolve the storage directories from config. Values only — paths.js (which
// already owns path building) is what creates these on disk.
// ---------------------------------------------------------------------------

const UPLOADS_DIR = path.resolve(config.UPLOADS_DIR);
const THUMBS_DIR = path.resolve(config.THUMBS_DIR);

module.exports = {
  MAX_UPLOAD_BYTES,
  THUMB_WIDTH,
  THUMB_JPEG_QUALITY,
  ALLOWED_MIME_TO_EXT,
  ALLOWED_LABEL,
  DISALLOWED_TYPE_MESSAGE,
  HEIC_RATE_LIMIT_MESSAGE,
  GUEST_SAFE_CONVERT_CODES,
  HEIC_OVERSIZE_MESSAGE,
  HEIC_CANDIDATE_MIMES,
  HEIC_FTYP_BRANDS,
  MAX_HEIC_PIXELS,
  UPLOADS_DIR,
  THUMBS_DIR,
};
