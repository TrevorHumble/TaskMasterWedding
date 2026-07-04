# 05 — Photo upload handling, thumbnails, storage & serving

This section delivers **one file**: `src/services/photos.js`. It is the single place that knows how guest photos (and guest avatars) are received, validated, written to disk, thumbnailed, located, hidden, restored, and (optionally) hard-deleted.

It is consumed later by:
- `src/routes/auth.js` (section 03) — calls `saveAvatar(buffer, guestId)` during onboarding to persist the guest's avatar photo. (Onboarding uses multer **memory** storage for the avatar field, so auth.js genuinely has a `buffer`; this is the one place a buffer is handed to photos.js. See "Storage model" below.)
- `src/routes/guest.js` (section 04) — uses the exported `upload` middleware on `POST /tasks/:id/submit`, then calls `makeThumb(req.file.path)` and the path/URL builders. Section 04's submit handler is the **single canonical** submission pipeline; it stores `req.file.filename` and the exact filename `makeThumb()` returns.
- `src/routes/admin.js` (section 08) — calls `hideSubmission()` / `restoreSubmission()` for photo takedown/restore, and `urlForThumb()` / `urlForOriginal()` to render the admin photos list.

You only write `photos.js` here. Where another section's file must call into this one, you will see an **"ADD THIS to …"** block — that is reference for the other section's author, not something you create now.

---

## Storage model — read this first (it reconciles sections 03 / 04 / 05)

There are **two upload paths** in this app, and they deliberately use **different multer storage engines**. This is the single source of truth for both; sections 03 and 04 must match it exactly.

| Path | Where configured | multer storage | Field name | What photos.js receives | photos.js function |
|------|------------------|----------------|------------|-------------------------|--------------------|
| **Task submission** (the main pipeline, ~15 per guest) | `photos.js` exports `upload` middleware; used on the route in `guest.js` (04) | **disk** (`multer.diskStorage`) | `photo` | `req.file.path` + `req.file.filename` (NO `req.file.buffer`) | `makeThumb(req.file.path)` |
| **Onboarding avatar** (one per guest, optional) | `auth.js` (03) configures its own `multer.memoryStorage()` | **memory** | `avatar` | a `Buffer` it passes in | `saveAvatar(buffer, guestId)` |

Why two engines:
- The **task-submission** path is high-volume and the original must end up on disk anyway, so disk storage is the simplest correct setup — multer hands us a file already written, and `makeThumb()` reads that path. There is **no `req.file.buffer`** on this path; anything that reads `req.file.buffer` here is a bug.
- The **onboarding avatar** path is configured inside `auth.js` (section 03) with `multer.memoryStorage()` because the avatar handler does its own thing with the bytes before persisting. That handler hands the raw `buffer` to `photos.saveAvatar(buffer, guestId)`, which writes it to disk and returns the stored filename. `saveAvatar` is a **real export of this file** (defined below) — auth.js's lazy `require('../services/photos').saveAvatar(...)` resolves to it, so onboarding avatars are actually saved (no silent no-op).

**There is exactly ONE task-submission pipeline.** The earlier draft of section 04 referenced functions named `saveSubmissionPhoto` / `deletePhotoFiles` / `uploadSingle` and assumed memory storage. Those names **do not exist** in this file and must not appear in section 04. The canonical submit handler — shown verbatim in **Step 5** below — is the one section 04 pastes: `upload` middleware on the route → `makeThumb(req.file.path)` → manual `INSERT` using `req.file.filename` (original) and the exact name `makeThumb()` returns (thumbnail). The thumbnail filename stored in `submissions.thumb_path` is **exactly** what `makeThumb()` returns, so `/thumbs/<thumb_path>` always resolves to the real file on disk.

The real exports of this file are: `upload`, `makeThumb`, `saveAvatar`, `urlForOriginal`, `urlForThumb`, `absOriginalPath`, `absThumbPath`, `hideSubmission`, `restoreSubmission`, `hardDelete`, `deleteOriginalFile`, `deleteThumbFile`, and the constants `MAX_UPLOAD_BYTES`, `THUMB_WIDTH`, `ALLOWED_LABEL`.

---

## What this file decides (read once before coding)

- **Storage engine (task submissions).** multer is configured with **disk storage** (not memory). The original photo is written straight to `data/uploads/` by multer with a random `crypto`-generated filename that **keeps the uploaded file's extension** (`.jpg`, `.png`, `.webp`, `.heic`). multer hands us a file already on disk, and `makeThumb()` reads that file to produce the thumbnail.
- **Avatars (onboarding).** The avatar arrives as a `Buffer` (auth.js uses memory storage for that one field) and is persisted by `saveAvatar(buffer, guestId)`, which writes the bytes to `data/uploads/` and returns the stored filename. This is the only place this file accepts a buffer.
- **File filter.** Only common image types are accepted: JPEG, PNG, WebP, and HEIC (HEIC is what iPhones produce). HEIC support is **intentional** so guests uploading straight from an iPhone are not rejected; this is the one place HEIC acceptance is stated. Anything else is rejected with a clear, human-readable error so the route can show a friendly message. **Superseded by issue #188 (2026-07-04):** HEIC is now rejected at intake with actionable copy — the prebuilt sharp binaries have no HEVC decoder, so HEIC could never be thumbnailed or displayed. See `src/services/photos.js`.
- **Size limit.** 15 MB per file. A phone photo is typically 2–6 MB; 15 MB leaves comfortable headroom and still protects the laptop's disk against a runaway upload. Sized fine for ~15 photos per guest.
- **Thumbnails.** `makeThumb()` uses **sharp** to write a **width-400 JPEG** into `data/thumbs/`, reusing the original's full filename with a `.jpg` extension appended. 400px matches the `width=400 height=400` markup and `aspect-ratio: 1/1` CSS in the section-07 gallery, so thumbnails are not letterboxed or unexpectedly cropped, while staying tiny so the lazy-loading gallery stays fast.
- **Serving.** Originals are served from the `/uploads` static mount and thumbnails from the `/thumbs` static mount (both declared in `src/app.js`, section 01). This file only stores and returns the **relative filename**; the URL builders turn that filename into `/uploads/<name>` or `/thumbs/<name>`.
- **Takedown vs delete.** **Takedown HIDES, it does not delete:** `hideSubmission()` flips `submissions.taken_down = 1` so the photo disappears from gallery, profiles, and scoring, but the file stays on disk so it is still included in the admin export ZIP. A separate `hardDelete()` is provided for the rare case of permanently removing both files, but the admin UI uses takedown, not delete.
- **Who owns the upload constants.** `photos.js` is the **single source of truth** for `MAX_UPLOAD_BYTES`, `THUMB_WIDTH`, and the allowed-image-type list. Section 01's `config.js` does **not** define `maxUploadBytes` / `thumbWidth` / `allowedMime` (they were removed there to avoid two disagreeing copies). The only path keys `photos.js` reads from config are `UPLOADS_DIR` and `THUMBS_DIR`.

> **Install note:** `sharp@0.33.5` ships **prebuilt libvips binaries** for Windows x64 on Node 20. `npm install` pulls the right binary automatically — **no Visual Studio, no node-gyp, no build tools** are required. If you ever see a "Could not load the sharp module" error, it means the prebuilt binary did not download; the fix in step 4 below covers it.

---

## Step 1 — Confirm prerequisites are in place

These come from earlier sections. Do **not** create them here; just confirm they exist.

1. `config.js` (section 01) exports the two directory keys this file uses:
   - `UPLOADS_DIR` — absolute or project-relative path to `data/uploads`
   - `THUMBS_DIR` — path to `data/thumbs`

   It does **not** need to export `maxUploadBytes` / `thumbWidth` / `allowedMime` — those live in `photos.js` (see "Who owns the upload constants" above). If section 01 still defines them, they are unused; delete them there to avoid confusion, or leave them and ignore them — this file never reads them.
2. `src/db.js` (section 02) exports `db` (a better-sqlite3 instance). This file imports it for `hideSubmission` / `restoreSubmission` / `hardDelete` / `saveAvatar`.
3. `src/app.js` (section 01) creates `data/uploads` and `data/thumbs` on boot **and** declares the two static mounts. As a safety net, `photos.js` also creates both directories itself when it loads, so it works even if run in isolation.
4. `src/routes/auth.js` (section 03) configures its own `multer.memoryStorage()` for the `avatar` field and, on success, calls `require('../services/photos').saveAvatar(req.file.buffer, guest.id)`. (That is the **only** place `req.file.buffer` is correct — because that route uses memory storage.) You do not write auth.js here; just make sure the function name it calls (`saveAvatar`) matches what this file exports. It does.

> If `config.js` does not yet export `UPLOADS_DIR` / `THUMBS_DIR`, stop and finish section 01 first. Do not hardcode paths in this file beyond reading them from config.

---

## Step 2 — Create the file

In **PowerShell**, from the project root (`garden-party-pastels\`):

```powershell
New-Item -ItemType Directory -Force src\services | Out-Null
if (-not (Test-Path src\services\photos.js)) { New-Item -ItemType File src\services\photos.js | Out-Null }
```

Then paste the full contents below into `src\services\photos.js`.

---

## Step 3 — Full file contents

Paste this **exactly**. Do not trim comments — they document the non-obvious bits a future reader needs.

```javascript
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
```

> **Schema note for section 02:** `saveAvatar` writes to a `guests.avatar_path` column. If section 02's `guests` table does not yet have an `avatar_path TEXT` column, add it there (this is the column auth.js's onboarding fills). This file assumes the column exists; it does not create or migrate schema.

---

## Step 4 — Verify sharp installed its native binary

`sharp` should already be in `package.json` (section 01) at version `0.33.5`. Confirm it loads. From the project root in **PowerShell**:

```powershell
node -e "const s=require('sharp'); console.log('sharp OK, libvips', s.versions.vips)"
```

Expected: a line like `sharp OK, libvips 8.15.x`.

If instead you see `Could not load the sharp module`, the prebuilt binary did not download. Fix it by reinstalling with the correct platform target, then re-run the check above:

```powershell
npm install --os=win32 --cpu=x64 sharp@0.33.5
```

---

## Step 5 — How the other sections call this file (reference only — do NOT create these now)

These blocks belong to sections 03, 04 and 08. They are shown so you understand the contract `photos.js` must satisfy. The other sections' authors paste them into their own files. **The guest.js block below is the single canonical submit handler** — there is no competing `saveSubmissionPhoto` version anywhere; section 04 uses exactly this.

**ADD THIS to `src/routes/auth.js` (section 03) — onboarding avatar (MEMORY storage):**

```javascript
// src/routes/auth.js  (excerpt — owned by section 03)
//
// IMPORTANT: the avatar path is the ONE place we use multer MEMORY storage, because
// auth.js hands the raw bytes to photos.saveAvatar(buffer, guestId). The field name
// is 'avatar' (NOT 'photo'). Task submissions use photos.upload (disk) instead.
const multer = require('multer');
const photos = require('../services/photos');

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: photos.MAX_UPLOAD_BYTES, files: 1 },
}).single('avatar');

// POST /onboard  (excerpt) — avatarUpload runs first so req.file.buffer is populated.
router.post('/onboard', avatarUpload, async (req, res) => {
  // ... create/look up the guest, get guest.id ...
  if (req.file && req.file.buffer) {
    try {
      await photos.saveAvatar(req.file.buffer, guest.id); // writes file + sets guests.avatar_path
    } catch (err) {
      // Avatar is optional; log but don't block onboarding.
      console.error('avatar save failed:', err.message);
    }
  }
  // ... continue onboarding redirect ...
});
```

**ADD THIS to `src/routes/guest.js` (section 04) — the canonical submit handler (DISK storage):**

```javascript
// src/routes/guest.js  (excerpt — owned by section 04; THIS is the only submit pipeline)
const photos = require('../services/photos');
const { db } = require('../db');

// POST /tasks/:id/submit  (requireGuest middleware already applied on the router)
// photos.upload is multer DISK storage on field 'photo'. After it runs we have
// req.file.path (absolute disk path) and req.file.filename (the stored name) —
// there is NO req.file.buffer here.
router.post('/tasks/:id/submit', photos.upload, async (req, res) => {
  // multer error (bad type or too big) lands in the router error handler below,
  // OR you can wrap photos.upload to convert it to a flash message.
  const guest = res.locals.guest;        // set by attachGuest (section 03)
  const taskId = Number(req.params.id);

  if (!req.file) {
    res.redirect(`/tasks/${taskId}?msg=` + encodeURIComponent('Please choose a photo.'));
    return;
  }

  let thumbName;
  try {
    thumbName = await photos.makeThumb(req.file.path); // width-400 jpeg; returns exact filename
  } catch (err) {
    photos.deleteOriginalFile(req.file.filename);      // clean up the stray original
    throw err;
  }

  try {
    // Store req.file.filename (original) and thumbName EXACTLY as returned by makeThumb,
    // so /uploads/<photo_path> and /thumbs/<thumb_path> both resolve to real files.
    db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption)
       VALUES (?, ?, ?, ?, ?)`
    ).run(guest.id, taskId, req.file.filename, thumbName, (req.body.caption || '').trim());
  } catch (err) {
    // UNIQUE(guest_id, task_id) -> already submitted for this task.
    photos.deleteOriginalFile(req.file.filename);
    photos.deleteThumbFile(thumbName);
    if (String(err.message).includes('UNIQUE')) {
      res.redirect(`/tasks/${taskId}?msg=` + encodeURIComponent('You already submitted a photo for this task.'));
      return;
    }
    throw err;
  }

  // scoring + auto-badges recomputed in section 06 (call its service here).
  res.redirect(`/tasks/${taskId}?msg=` + encodeURIComponent('Photo submitted!'));
});
```

> The earlier `saveSubmissionPhoto({guestId,taskId,buffer})` / `deletePhotoFiles` / `uploadSingle` names are **gone**. If you see them anywhere in section 04, replace that handler with the one above — those functions do not exist in `photos.js` and assumed memory storage that this app does not use for submissions.

**ADD THIS to `src/routes/admin.js` (section 08) — takedown / restore:**

```javascript
// src/routes/admin.js  (excerpt — owned by section 08)
const photos = require('../services/photos');

// POST /admin/photos/:submissionId/takedown  (requireAdmin already applied)
router.post('/admin/photos/:submissionId/takedown', (req, res) => {
  photos.hideSubmission(Number(req.params.submissionId));
  // section 06: recompute scoring/auto-badges since a hidden photo no longer counts
  res.redirect('/admin/photos?msg=' + encodeURIComponent('Photo taken down.'));
});

// POST /admin/photos/:submissionId/restore
router.post('/admin/photos/:submissionId/restore', (req, res) => {
  photos.restoreSubmission(Number(req.params.submissionId));
  res.redirect('/admin/photos?msg=' + encodeURIComponent('Photo restored.'));
});
```

---

## Acceptance check

Run these from the project root in **PowerShell**. Each has an exact expected result.

**1. The module loads and exports everything.**

```powershell
node -e "const p=require('./src/services/photos'); console.log(Object.keys(p).sort().join(','))"
```
Expected (order may differ; this is sorted): 
`ALLOWED_LABEL,MAX_UPLOAD_BYTES,THUMB_WIDTH,absOriginalPath,absThumbPath,deleteOriginalFile,deleteThumbFile,hardDelete,hideSubmission,makeThumb,restoreSubmission,saveAvatar,upload,urlForOriginal,urlForThumb`

**2. Constants and URL builders behave.**

```powershell
node -e "const p=require('./src/services/photos'); console.log(p.MAX_UPLOAD_BYTES===15728640, p.THUMB_WIDTH===400, p.urlForOriginal('x.jpg')==='/uploads/x.jpg', p.urlForThumb('x.jpg.jpg')==='/thumbs/x.jpg.jpg')"
```
Expected: `true true true true`

**3. The storage directories exist after loading the module.**

```powershell
node -e "require('./src/services/photos')"
Test-Path data\uploads
Test-Path data\thumbs
```
Expected: two `True` lines.

**4. `makeThumb` actually produces a width-400 JPEG.** This generates a throwaway 1200px test PNG, thumbnails it, then prints the result's dimensions and format.

```powershell
node -e "const sharp=require('sharp'); const fs=require('fs'); const cfg=require('./config'); const dir=require('path').resolve(cfg.UPLOADS_DIR); fs.mkdirSync(dir,{recursive:true}); const f=require('path').join(dir,'__accept-test.png'); sharp({create:{width:1200,height:800,channels:3,background:{r:240,g:200,b:210}}}).png().toFile(f).then(()=>{const p=require('./src/services/photos'); return p.makeThumb(f).then(name=>{const t=require('path').join(require('path').resolve(cfg.THUMBS_DIR),name); return sharp(t).metadata().then(m=>{console.log('thumb',name,m.format,m.width+'x'+m.height); fs.unlinkSync(f); fs.unlinkSync(t);});});}).catch(e=>{console.error('FAIL',e.message); process.exit(1);})"
```
Expected: a line like `thumb __accept-test.png.jpg jpeg 400x267` — format **jpeg**, width **400**, and no `FAIL`. (The two test files delete themselves.) Note the thumbnail filename is the original's full name with `.jpg` appended (`__accept-test.png.jpg`) — that exact name is what gets stored in `submissions.thumb_path`.

**5. `saveAvatar` accepts a Buffer and writes a normalized JPEG.** This builds an in-memory PNG buffer (as auth.js would receive from memory storage), passes it to `saveAvatar`, and confirms a file was written and the guests row updated. It uses a temporary throwaway guest id of `-999` so it cannot collide with a real guest; adjust if your schema rejects negative ids.

```powershell
node -e "const sharp=require('sharp'); const fs=require('fs'); const cfg=require('./config'); const p=require('./src/services/photos'); const {db}=require('./src/db'); db.prepare('INSERT OR IGNORE INTO guests (id, token, name) VALUES (?, ?, ?)').run(-999,'__avatartoken','__avatartest'); sharp({create:{width:800,height:800,channels:3,background:{r:200,g:220,b:255}}}).png().toBuffer().then(buf=>p.saveAvatar(buf,-999)).then(name=>{const t=require('path').join(require('path').resolve(cfg.UPLOADS_DIR),name); return sharp(t).metadata().then(m=>{const row=db.prepare('SELECT avatar_path FROM guests WHERE id=?').get(-999); console.log('avatar',name,m.format,m.width+'x'+m.height,'dbmatch',row.avatar_path===name); fs.unlinkSync(t); db.prepare('DELETE FROM guests WHERE id=?').run(-999);});}).catch(e=>{console.error('FAIL',e.message); process.exit(1);})"
```
Expected: a line like `avatar <name>.jpg jpeg 512x512 dbmatch true` — format **jpeg**, **512x512**, `dbmatch true`, no `FAIL`. (The throwaway row supplies `token` because `guests.token` is `NOT NULL UNIQUE`, plus `name`. The test row deletes itself at the end.)

**6. Live end-to-end (after sections 01–04 exist).** Start the app (`npm start`), open a guest link, complete onboarding **with an avatar photo**, then go to a task, upload a real phone photo, and submit.
- Expected on onboarding: the avatar is written to `data\uploads\` and `guests.avatar_path` is set (it shows on the guest's profile in section 07).
- Expected on submit screen: redirect back to the task page showing "Photo submitted!".
- Expected on disk: one new file in `data\uploads\` and one matching `*.jpg` in `data\thumbs\` whose name is the original filename + `.jpg`.
- Re-submitting a second photo for the **same** task: redirect shows "You already submitted a photo for this task." and **no** extra files are left in `data\uploads\` or `data\thumbs\` (the cleanup helpers removed the strays).
- Uploading a non-image (a genuine `.pdf`, or a `.txt` whose real MIME is not an image) is rejected: the multer error carries the message "That file type is not allowed. Please upload a JPEG, PNG, WebP, or HEIC image."

If checks 1–5 pass exactly as shown, `src/services/photos.js` is correct and complete.
