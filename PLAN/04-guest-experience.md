# 04 — Guest pages: profile, tasks, upload, edit profile

This section builds everything a signed-in guest sees and does: their personal home/profile page, the task list, each task's detail + photo upload, the upload handler, and the edit-profile page. It also adds a small client-side script that shows a photo preview before the guest submits.

Everything in this section lives **behind `requireGuest`** — the middleware from section 03 that loads the current guest from the signed `gsid` cookie. If a visitor has no valid guest cookie, `requireGuest` sends them to the "link required" page. You do not re-write that middleware here; you just use it.

## What you will create in this section

| File | What it is |
|------|-----------|
| `src/routes/guest.js` | The Express router with all 7 guest routes |
| `src/views/guest-home.ejs` | The guest's own profile/home page (`GET /`) |
| `src/views/tasks.ejs` | The task list (`GET /tasks`) |
| `src/views/task.ejs` | One task + upload form (`GET /tasks/:id`) |
| `src/views/me-edit.ejs` | Edit name / avatar / social links (`GET /me/edit`) |
| `src/public/js/upload.js` | Client-side image preview before submit |

## Things from other sections you depend on (DO NOT re-create these)

These already exist (or will) because other sections own them. You only *call* them.

- **`requireGuest`** — middleware exported from `src/middleware/session.js` (section 03). It sets `res.locals.guest` to the current guest row and `req.guest` too. We use `res.locals.guest` in views and `req.guest` (or `res.locals.guest`) in routes.
- **`res.locals.flash`** — the flash message object, set up by `attachGuest` in section 03. We *write* a flash by calling a small helper we define locally (see step 2) that sets a short-lived signed `flash` cookie. **Section 03's `attachGuest` must read that signed cookie back into `res.locals.flash` and clear it** so the message shows exactly once (see the "Flash contract" box below). The flash object shape is standardized as **`{ type, msg }`** where `type` is `'ok'` or `'err'` — this matches section 10's `header.ejs`, which reads `flash.type` and `flash.msg`.
- **The photos service** — `src/services/photos.js` (section 05). This section uses section 05's **real exports** (no invented names):
  - `upload` → the multer **disk-storage** middleware, ALREADY BOUND to `single('photo')`. Call it directly: `photos.upload(req, res, cb)` (do not call `.single` on it). After it runs, the saved file is on disk and `req.file.filename` is the stored original's filename, `req.file.path` its absolute path.
  - `makeThumb(originalPath)` → generates a thumbnail for the just-uploaded original and **returns the thumbnail's filename** (relative, to store in the DB).
  - `deleteOriginalFile(filename)` / `deleteThumbFile(filename)` → delete a stored original / thumbnail from disk when a guest replaces a photo or avatar.
  - `saveAvatar(buffer, guestId)` → **avatar** helper (section 05). It is **async**, takes the raw image bytes (a Buffer), writes the avatar file, sets `guests.avatar_path`, and returns the stored filename. On `/me/edit` (disk storage) we read the upload back into a Buffer first; to remove a replaced avatar we call `deleteOriginalFile(filename)` (there is no `deleteAvatarFile`). Avatars never go through the submission pipeline.
  - **Until section 05 is built, `guest.js` cannot fully run.** That is expected and fine — this section is written to match the exact function names section 05 provides. Build section 05 before testing the upload route end-to-end. The non-upload routes (`/`, `/tasks`, `/tasks/:id`, `/me/edit`) work without section 05, **except** that `GET/POST /me/edit` saves an avatar and so also uses the photos service.
- **The scoring service** — `src/services/scoring.js` (section 06). We call section 06's **real exports**:
  - `getPoints(guestId)` → returns a number: completed tasks (not taken down) + bonus points.
  - `getGuestBadges(guestId)` → returns an array of the guest's badge rows joined to the `badges` catalog (each has `code`, `name`, `art_path`). **Section 06 adds and exports this function.**
  - `recomputeAutoBadges(guestId)` → recomputes points and auto-grants/revokes the BLOOM/BOUQUET/GARDEN badges. Call this after every submission change.
  - `BADGE_THRESHOLDS` → the exported constant array of `{ code, n }` objects (the completed-task counts for the three auto badges). We derive the numeric thresholds with `BADGE_THRESHOLDS.map(function (t) { return t.n; })`, which gives `[5, 10, 15]`, to draw the "progress to next badge" bar.
  - **Until section 06 is built, `guest.js` cannot fully run** for the same reason. The router is written against these exact names.
- **`db`** — the better-sqlite3 connection. `src/db.js` (section 02) exports an **object**: `module.exports = { db, getCompletedCount, ... }`. So you must **destructure** the connection: `const { db } = require('../db');`. It is **synchronous**: use `db.prepare(sql).get(...)`, `.all(...)`, `.run(...)`. There is no `await`.
- **The partials** — `partials/head.ejs`, `partials/header.ejs`, `partials/footer.ejs` (section 10). Every view includes them. They open/close the HTML document, load the theme CSS + Google Fonts, and the footer loads a page-specific JS file when the view passes a `pageScript` variable. **`footer.ejs` builds the tag as `<script src="/js/<%= pageScript %>"></script>` — it prepends `/js/` itself.** Therefore `pageScript` must be a **bare filename including the extension**, e.g. `'upload.js'` (NOT `'/js/upload.js'`, which would produce the broken `/js//js/upload.js`). The views below pass `pageScript: 'upload.js'`.

> **Flash contract (section 03 owns the read side):** `guest.js` (this section) *writes* a signed cookie named `flash` containing `JSON.stringify({ type, msg })`. Section 03's `attachGuest` middleware *reads* it: after setting `res.locals.guest`, it reads `req.signedCookies.flash`, `JSON.parse`s it into `res.locals.flash` (inside a `try/catch` that falls back to `null`), and clears it with `res.clearCookie('flash', { path: '/' })`. This makes the flash show exactly once and prevents a stale cookie from lingering. The shape `{ type, msg }` is identical in `guest.js`, every view in this section, and section 10's `header.ejs`. **If section 03 does not yet do this read/clear, add it there — do not work around it here.**

> **Important integration detail about `footer.ejs` (section 10 owns it):** the footer loads a page script when the view sets `pageScript` (a bare filename). Our `task.ejs` and `me-edit.ejs` need `/js/upload.js`. To make the preview robust regardless of how section 10 wrote the footer, those two views **also include a direct `<script src="/js/upload.js" defer></script>` tag themselves** right before the footer include. That guarantees the preview works even if the footer's page-script mechanism differs. This is a deliberate, harmless redundancy — and because `pageScript` is now a correct bare filename, the footer's own tag resolves to the same valid URL rather than a 404.

---

## Step 1 — Confirm the folders and dependencies exist

You should already have run the install/seed steps from sections 01 and 02. In **PowerShell**, from the project root (`garden-party-pastels/`), confirm the key files exist:

```powershell
# (run from the project root: garden-party-pastels\)
Test-Path .\src\db.js
Test-Path .\src\middleware\session.js
Test-Path .\src\views\partials\head.ejs
Test-Path .\src\public\js
```

If `Test-Path .\src\public\js` returns `False`, create the folder:

```powershell
New-Item -ItemType Directory -Force .\src\public\js
```

Do **not** proceed to testing the upload route until sections 05 (photos) and 06 (scoring) are built, because `guest.js` imports from both. You can still create all the files now.

---

## Step 2 — Create the router: `src/routes/guest.js`

Create the file exactly as below. Read the inline comments — they explain each route. This file imports the photos and scoring services by their **real** (section 05 / section 06) names, destructures the `db` connection from the db module, and uses the standardized `{ type, msg }` flash shape.

```javascript
// src/routes/guest.js
'use strict';

const express = require('express');
const router = express.Router();

// db.js exports an OBJECT { db, getCompletedCount, ... }. Destructure the
// better-sqlite3 connection itself, or db.prepare(...) is undefined.
const { db } = require('../db');
const config = require('../../config');

// requireGuest comes from section 03. It loads the current guest into
// res.locals.guest (and req.guest) from the signed gsid cookie, or
// redirects visitors who have no valid guest link.
const { requireGuest } = require('../middleware/session');

// Photos service (section 05) — REAL exports only.
// `upload` is the multer DISK-storage middleware ALREADY BOUND to single('photo')
// — call it directly as `photos.upload(req, res, cb)` (do NOT call .single on it).
// After it runs, req.file.filename is the stored original filename and
// req.file.path its absolute path. makeThumb(path) is ASYNC and returns the
// thumbnail filename. saveAvatar(buffer, guestId) is ASYNC, writes the avatar
// file, sets guests.avatar_path, and returns the filename. deleteOriginalFile()
// and deleteThumbFile() remove files from disk.
const photos = require('../services/photos');

// Scoring service (section 06) — REAL exports only.
const scoring = require('../services/scoring');

// Numeric auto-badge thresholds derived from the {code,n} catalog.
// e.g. BADGE_THRESHOLDS = [{code:'BLOOM',n:5},{code:'BOUQUET',n:10},{code:'GARDEN',n:15}]
// -> AUTO_THRESHOLDS = [5, 10, 15]
const AUTO_THRESHOLDS = scoring.BADGE_THRESHOLDS
  .map(function (t) { return t.n; })
  .sort(function (a, b) { return a - b; });

// ---------------------------------------------------------------------------
// Small local helper: set a one-shot flash message.
// Section 03's attachGuest reads the signed `flash` cookie into
// res.locals.flash on the NEXT request, then clears it. We write it here.
// kind is 'success' or 'error'; text is the message. We normalize to the
// shape header.ejs (section 10) reads: { type: 'ok' | 'err', msg: '...' }.
// ---------------------------------------------------------------------------
function setFlash(res, kind, text) {
  const type = kind === 'success' ? 'ok' : 'err';
  res.cookie(
    'flash',
    JSON.stringify({ type: type, msg: text }),
    {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      signed: true,
      path: '/',
      maxAge: 30 * 1000, // 30 seconds is plenty to survive one redirect
    }
  );
}

// Every route in this router requires a signed-in guest.
router.use(requireGuest);

// ---------------------------------------------------------------------------
// GET /  — the guest's own home / profile page.
// Shows: points, badges (with art), completed vs total tasks, and a
// progress bar toward the next auto badge.
// ---------------------------------------------------------------------------
router.get('/', function (req, res) {
  const guest = res.locals.guest;

  // Total active tasks (guests only ever see active tasks).
  const totalActiveRow = db
    .prepare('SELECT COUNT(*) AS n FROM tasks WHERE is_active = 1')
    .get();
  const totalTasks = totalActiveRow.n;

  // Completed tasks for this guest = visible submissions (taken_down = 0) with
  // NO is_active filter — this is the canonical rule scoring/badges/leaderboard
  // (section 06) use, so the home count never disagrees with points and badges.
  const completedRow = db
    .prepare(
      `SELECT COUNT(*) AS n
         FROM submissions s
        WHERE s.guest_id = ?
          AND s.taken_down = 0`
    )
    .get(guest.id);
  const completedTasks = completedRow.n;

  // Points and badges from the scoring service (section 06 real exports).
  const points = scoring.getPoints(guest.id);
  const badges = scoring.getGuestBadges(guest.id); // each: {code,name,art_path,...}

  // The guest's own (non-taken-down) submissions, newest first, joined to
  // task title so we can label each thumbnail on the home page.
  const submissions = db
    .prepare(
      `SELECT s.id, s.task_id, s.photo_path, s.thumb_path, s.caption,
              s.created_at, t.title AS task_title
         FROM submissions s
         JOIN tasks t ON t.id = s.task_id
        WHERE s.guest_id = ?
          AND s.taken_down = 0
        ORDER BY s.created_at DESC, s.id DESC`
    )
    .all(guest.id);

  // Progress to next auto badge.
  // AUTO_THRESHOLDS is [5, 10, 15]. Find the first threshold the guest has
  // not yet reached. If they've reached the highest, they're maxed out.
  let nextThreshold = null;
  for (let i = 0; i < AUTO_THRESHOLDS.length; i++) {
    if (completedTasks < AUTO_THRESHOLDS[i]) {
      nextThreshold = AUTO_THRESHOLDS[i];
      break;
    }
  }
  // The previous threshold (lower bound of the current band) so the bar
  // fills from the last badge to the next, not from zero each time.
  let prevThreshold = 0;
  for (let i = 0; i < AUTO_THRESHOLDS.length; i++) {
    if (AUTO_THRESHOLDS[i] <= completedTasks) {
      prevThreshold = AUTO_THRESHOLDS[i];
    }
  }

  let progressPercent;
  let remainingToNext;
  if (nextThreshold === null) {
    progressPercent = 100;
    remainingToNext = 0;
  } else {
    const span = nextThreshold - prevThreshold;
    const into = completedTasks - prevThreshold;
    progressPercent = Math.max(0, Math.min(100, Math.round((into / span) * 100)));
    remainingToNext = nextThreshold - completedTasks;
  }

  res.render('guest-home', {
    title: 'My Garden',
    points: points,
    badges: badges,
    submissions: submissions,
    totalTasks: totalTasks,
    completedTasks: completedTasks,
    nextThreshold: nextThreshold,
    remainingToNext: remainingToNext,
    progressPercent: progressPercent,
  });
});

// ---------------------------------------------------------------------------
// GET /tasks  — list all ACTIVE tasks with this guest's done/not-done state.
// ---------------------------------------------------------------------------
router.get('/tasks', function (req, res) {
  const guest = res.locals.guest;

  // For each active task, join the guest's submission (if any) so we know
  // whether it is done. taken_down submissions do NOT count as done.
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.sort_order,
              CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS done,
              s.thumb_path AS thumb_path
         FROM tasks t
         LEFT JOIN submissions s
                ON s.task_id = t.id
               AND s.guest_id = ?
               AND s.taken_down = 0
        WHERE t.is_active = 1
        ORDER BY t.sort_order ASC, t.id ASC`
    )
    .all(guest.id);

  const doneCount = tasks.filter(function (t) { return t.done === 1; }).length;

  res.render('tasks', {
    title: 'Tasks',
    tasks: tasks,
    doneCount: doneCount,
    totalCount: tasks.length,
  });
});

// ---------------------------------------------------------------------------
// GET /tasks/:id  — one task's detail + the upload form. If the guest has
// already submitted (and it's not taken down), show their photo and allow
// replacing it.
// ---------------------------------------------------------------------------
router.get('/tasks/:id', function (req, res) {
  const guest = res.locals.guest;
  const taskId = Number(req.params.id);

  if (!Number.isInteger(taskId) || taskId <= 0) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  const task = db
    .prepare('SELECT id, title, description, is_active FROM tasks WHERE id = ?')
    .get(taskId);

  // Hide inactive or missing tasks from guests.
  if (!task || task.is_active !== 1) {
    return res.status(404).render('404', { title: 'Not found' });
  }

  // Existing, non-taken-down submission for this guest+task (may be null).
  const submission = db
    .prepare(
      `SELECT id, photo_path, thumb_path, caption, created_at
         FROM submissions
        WHERE guest_id = ? AND task_id = ? AND taken_down = 0`
    )
    .get(guest.id, taskId);

  res.render('task', {
    title: task.title,
    task: task,
    submission: submission, // null if none yet
    pageScript: 'upload.js', // bare filename; footer.ejs prepends /js/
  });
});

// ---------------------------------------------------------------------------
// POST /tasks/:id/submit  — handle the multipart photo upload.
// Field name is "photo" (single). photos.upload is multer DISK storage, so
// after the middleware runs req.file.filename is the stored original filename
// and req.file.path its absolute path on disk. We make a thumbnail with
// photos.makeThumb(req.file.path), insert OR replace the submission
// (UNIQUE(guest_id,task_id)), save caption, recompute scoring, then redirect
// back with a flash.
// ---------------------------------------------------------------------------
router.post('/tasks/:id/submit', function (req, res) {
  // Run multer first; it may error (file too big, wrong type, no file).
  // photos.upload is the ALREADY-BOUND single('photo') middleware (section 05),
  // so call it directly. The callback is async because makeThumb() is async.
  photos.upload(req, res, async function (err) {
    const guest = res.locals.guest;
    const taskId = Number(req.params.id);

    if (!Number.isInteger(taskId) || taskId <= 0) {
      return res.status(404).render('404', { title: 'Not found' });
    }

    // Task must exist and be active.
    const task = db
      .prepare('SELECT id, is_active FROM tasks WHERE id = ?')
      .get(taskId);
    if (!task || task.is_active !== 1) {
      return res.status(404).render('404', { title: 'Not found' });
    }

    if (err) {
      // Multer/file-filter error (size limit or disallowed type).
      setFlash(res, 'error', 'That photo could not be uploaded: ' + err.message);
      return res.redirect('/tasks/' + taskId);
    }

    // Disk storage: a successful upload has req.file with .filename and .path.
    if (!req.file) {
      setFlash(res, 'error', 'Please choose a photo to upload.');
      return res.redirect('/tasks/' + taskId);
    }

    // Caption is optional; trim and cap length defensively.
    let caption = '';
    if (typeof req.body.caption === 'string') {
      caption = req.body.caption.trim().slice(0, 500);
    }

    // The original is already saved on disk by multer. Make the thumbnail.
    // photo_path = the stored original's filename; thumb_path = makeThumb()'s
    // returned thumbnail filename.
    const photoPath = req.file.filename;
    let thumbPath;
    try {
      thumbPath = await photos.makeThumb(req.file.path); // makeThumb is async
    } catch (e) {
      // Clean up the orphaned original we just wrote, then bail.
      try { photos.deleteOriginalFile(photoPath); } catch (e2) { /* non-fatal */ }
      setFlash(res, 'error', 'Sorry, we could not save that photo. Please try again.');
      return res.redirect('/tasks/' + taskId);
    }

    // Is there an existing submission for this guest+task? UNIQUE constraint
    // means at most one row. We REPLACE the photo if it exists.
    const existing = db
      .prepare(
        'SELECT id, photo_path, thumb_path FROM submissions WHERE guest_id = ? AND task_id = ?'
      )
      .get(guest.id, taskId);

    if (existing) {
      // Replace: update paths + caption, clear taken_down, and delete the
      // old files from disk so we don't leave orphans.
      const oldPhoto = existing.photo_path;
      const oldThumb = existing.thumb_path;

      db.prepare(
        `UPDATE submissions
            SET photo_path = ?, thumb_path = ?, caption = ?, taken_down = 0,
                created_at = datetime('now')
          WHERE id = ?`
      ).run(photoPath, thumbPath, caption, existing.id);

      // Delete old files AFTER the DB update succeeds. Ignore failures.
      try {
        if (oldPhoto && oldPhoto !== photoPath) {
          photos.deleteOriginalFile(oldPhoto);
        }
        if (oldThumb && oldThumb !== thumbPath) {
          photos.deleteThumbFile(oldThumb);
        }
      } catch (e) {
        // Non-fatal: a leftover file is harmless.
      }
    } else {
      // First submission for this task.
      db.prepare(
        `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, caption, taken_down)
         VALUES (?, ?, ?, ?, ?, 0)`
      ).run(guest.id, taskId, photoPath, thumbPath, caption);
    }

    // Recompute points + auto badges now that completion may have changed.
    try {
      scoring.recomputeAutoBadges(guest.id);
    } catch (e) {
      // Scoring failure should not lose the photo; just log to console.
      // eslint-disable-next-line no-console
      console.error('recomputeAutoBadges failed:', e);
    }

    setFlash(res, 'success', existing ? 'Photo replaced!' : 'Task complete! +1 point.');
    return res.redirect('/tasks/' + taskId);
  });
});

// ---------------------------------------------------------------------------
// GET /me/edit  — edit own display name, avatar, and social links.
// social_links is stored as a JSON object string in guests.social_links.
// ---------------------------------------------------------------------------
router.get('/me/edit', function (req, res) {
  const guest = res.locals.guest;

  // Parse social_links JSON safely into an object for the form.
  let social = {};
  try {
    social = JSON.parse(guest.social_links || '{}');
    if (social === null || typeof social !== 'object') {
      social = {};
    }
  } catch (e) {
    social = {};
  }

  res.render('me-edit', {
    title: 'Edit My Profile',
    social: social,
    pageScript: 'upload.js', // bare filename; footer.ejs prepends /js/
  });
});

// ---------------------------------------------------------------------------
// POST /me/edit  — save name, optional new avatar, and social links.
// Avatar uses the SAME disk-storage `upload` middleware (field name "photo").
// Because saveAvatar wants a Buffer, we read the uploaded file back into bytes,
// call photos.saveAvatar(buffer, guestId) (async; it sets avatar_path), and
// remove a replaced avatar with deleteOriginalFile. No thumbnail, no submission
// row.
// ---------------------------------------------------------------------------
router.post('/me/edit', function (req, res) {
  // photos.upload is the ALREADY-BOUND single('photo') DISK-storage middleware
  // (section 05). The callback is async because saveAvatar() is async.
  photos.upload(req, res, async function (err) {
    const guest = res.locals.guest;

    if (err) {
      setFlash(res, 'error', 'That avatar could not be uploaded: ' + err.message);
      return res.redirect('/me/edit');
    }

    // Name: required-ish. If blank, keep the old name rather than wiping it.
    let name = '';
    if (typeof req.body.name === 'string') {
      name = req.body.name.trim().slice(0, 80);
    }
    if (name.length === 0) {
      name = guest.name; // keep existing
    }

    // Build the social_links JSON. Start from the EXISTING object so keys we
    // don't render here (e.g. facebook entered at onboarding) are PRESERVED
    // rather than wiped. We only overwrite the keys this form edits:
    // instagram, facebook, website. Empty values remove that key.
    let social = {};
    try {
      const parsed = JSON.parse(guest.social_links || '{}');
      if (parsed && typeof parsed === 'object') {
        social = parsed;
      }
    } catch (e) {
      social = {};
    }

    const editableKeys = ['instagram', 'facebook', 'website'];
    editableKeys.forEach(function (key) {
      const val = (req.body[key] || '').toString().trim().slice(0, 200);
      if (val) {
        social[key] = val;
      } else {
        delete social[key];
      }
    });
    const socialJson = JSON.stringify(social);

    // Optional new avatar. photos.saveAvatar expects the raw BYTES (a Buffer)
    // and is async (section 05). This route uses DISK storage, so multer wrote
    // the upload to req.file.path — read it back into a Buffer, hand it to
    // saveAvatar(buffer, guestId), then drop the raw upload. saveAvatar writes
    // the stored avatar file, sets guests.avatar_path, and returns the filename.
    const fs = require('fs');
    let newAvatarPath = guest.avatar_path; // keep existing unless replaced
    if (req.file) {
      let savedAvatar;
      try {
        const buf = fs.readFileSync(req.file.path);
        savedAvatar = await photos.saveAvatar(buf, guest.id); // stored filename
      } catch (e) {
        try { fs.unlinkSync(req.file.path); } catch (e2) { /* non-fatal */ }
        setFlash(res, 'error', 'Sorry, we could not save that avatar. Please try again.');
        return res.redirect('/me/edit');
      }
      // Drop the raw multer upload now that saveAvatar made its own copy.
      try { fs.unlinkSync(req.file.path); } catch (e2) { /* non-fatal */ }

      const oldAvatar = guest.avatar_path;
      newAvatarPath = savedAvatar;

      // Delete the previous avatar file if it changed. Avatars live in the
      // uploads dir (no thumbnail), so deleteOriginalFile removes them.
      try {
        if (oldAvatar && oldAvatar !== newAvatarPath) {
          photos.deleteOriginalFile(oldAvatar);
        }
      } catch (e) {
        // Non-fatal.
      }
    }

    db.prepare(
      'UPDATE guests SET name = ?, avatar_path = ?, social_links = ? WHERE id = ?'
    ).run(name, newAvatarPath, socialJson, guest.id);

    setFlash(res, 'success', 'Profile updated!');
    return res.redirect('/');
  });
});

module.exports = router;
```

> **Note on `require('../../config')`:** `guest.js` is in `src/routes/`, so `config.js` at the project root is two levels up. The variable is imported for completeness (e.g., if you later reference config keys); it does no harm if unused.

> **Note on avatars:** `photos.saveAvatar(buffer, guestId)` (section 05) takes the raw image **bytes** (a Buffer), is **async**, writes the avatar file, sets `guests.avatar_path`, and returns the stored filename. Because this route reuses the shared **disk-storage** `upload`, the handler above reads the just-uploaded file back into a Buffer before calling it. To remove a replaced avatar we call `photos.deleteOriginalFile(filename)` — avatars live in the uploads dir with no thumbnail, so there is no separate `deleteAvatarFile`. Avatars deliberately stay **out of the submission pipeline** (no thumbnail, no `submissions` row, no `task_id` sentinel).

---

## Step 3 — Mount the router in `src/app.js`

`src/app.js` is owned by section 01 and **auto-mounts** every router, so **NO CHANGE to `src/app.js` is needed** for this section.

Section 01's `app.js` auto-detects `src/routes/guest.js` and mounts it at `/` as soon as the file exists — and it already mounts the auth router **before** the guest router, so `/j/:token`, `/onboard`, and the admin login routes take precedence over the guest router's `GET /`. Do **not** add an explicit `app.use('/', require('./routes/guest'))` line: that would mount the guest router twice and every guest handler would run twice.

Once you have created `src/routes/guest.js`, restart the server (`npm start`) and the auto-mounter picks it up automatically.

---

## Step 4 — Create the view: `src/views/guest-home.ejs`

This is the guest's personal page. It uses only data the router passes in. All user-provided text (`guest.name`, captions) is rendered with `<%= %>` (auto-escaped) to prevent HTML injection. The flash object shape is `{ type, msg }` (matching `header.ejs`), where `type` is `'ok'` or `'err'`.

```html
<!-- src/views/guest-home.ejs -->
<%- include('partials/head', { title: title }) %>
<%- include('partials/header') %>

<main class="page page-home">

  <% if (typeof flash !== 'undefined' && flash) { %>
    <div class="flash flash-<%= flash.type %>"><%= flash.msg %></div>
  <% } else if (typeof locals.flash !== 'undefined' && locals.flash) { %>
    <div class="flash flash-<%= locals.flash.type %>"><%= locals.flash.msg %></div>
  <% } %>

  <section class="profile-card">
    <div class="profile-avatar">
      <% if (guest.avatar_path) { %>
        <img src="/uploads/<%= guest.avatar_path %>" alt="Your avatar" class="avatar-img" />
      <% } else { %>
        <div class="avatar-placeholder" aria-hidden="true">🌸</div>
      <% } %>
    </div>
    <div class="profile-meta">
      <h1 class="profile-name"><%= guest.name && guest.name.length ? guest.name : 'Welcome!' %></h1>
      <p class="profile-points"><strong><%= points %></strong> point<%= points === 1 ? '' : 's' %></p>
      <p class="profile-progress-text">
        <%= completedTasks %> of <%= totalTasks %> task<%= totalTasks === 1 ? '' : 's' %> complete
      </p>
      <p><a class="btn btn-secondary" href="/me/edit">Edit my profile</a></p>
    </div>
  </section>

  <section class="progress-section">
    <% if (nextThreshold === null) { %>
      <p class="progress-label">You've earned every auto badge — full garden! 🌷</p>
    <% } else { %>
      <p class="progress-label">
        <%= remainingToNext %> more task<%= remainingToNext === 1 ? '' : 's' %>
        to your next badge (at <%= nextThreshold %> tasks)
      </p>
    <% } %>
    <div class="progress-bar" role="progressbar"
         aria-valuenow="<%= progressPercent %>" aria-valuemin="0" aria-valuemax="100">
      <div class="progress-bar-fill" style="width: <%= progressPercent %>%;"></div>
    </div>
  </section>

  <section class="badges-section">
    <h2 class="section-title">My Badges</h2>
    <% if (badges.length === 0) { %>
      <p class="muted">No badges yet — complete tasks to earn your first bloom!</p>
    <% } else { %>
      <ul class="badge-grid">
        <% badges.forEach(function (b) { %>
          <li class="badge-item">
            <img src="<%= b.art_path %>" alt="<%= b.name %> badge" class="badge-art" />
            <span class="badge-name"><%= b.name %></span>
          </li>
        <% }); %>
      </ul>
    <% } %>
  </section>

  <section class="my-photos-section">
    <h2 class="section-title">My Photos</h2>
    <% if (submissions.length === 0) { %>
      <p class="muted">You haven't uploaded any photos yet. <a href="/tasks">See the tasks →</a></p>
    <% } else { %>
      <ul class="photo-grid">
        <% submissions.forEach(function (s) { %>
          <li class="photo-item">
            <a href="/tasks/<%= s.task_id %>">
              <img src="/thumbs/<%= s.thumb_path %>" alt="Photo for <%= s.task_title %>" class="photo-thumb" />
            </a>
            <span class="photo-caption"><%= s.task_title %></span>
          </li>
        <% }); %>
      </ul>
    <% } %>
  </section>

  <section class="home-nav">
    <a class="btn btn-primary" href="/tasks">View all tasks</a>
    <a class="btn btn-secondary" href="/gallery">Shared gallery</a>
    <a class="btn btn-secondary" href="/leaderboard">Leaderboard</a>
  </section>

</main>

<%- include('partials/footer') %>
```

> **About `flash`:** section 03's `attachGuest` reads the signed `flash` cookie into `res.locals.flash` (an object `{ type, msg }`) and clears it, so it shows exactly once. The two `if` branches above handle both the case where `flash` is a top-level local and where it's on `locals.flash`, and render nothing if neither exists. This makes the view safe regardless of exactly how section 03 wired the flash variable, as long as the shape is `{ type, msg }`.

---

## Step 5 — Create the view: `src/views/tasks.ejs`

The task list. Each task shows a done/not-done badge and links to its detail page.

```html
<!-- src/views/tasks.ejs -->
<%- include('partials/head', { title: title }) %>
<%- include('partials/header') %>

<main class="page page-tasks">

  <% if (typeof flash !== 'undefined' && flash) { %>
    <div class="flash flash-<%= flash.type %>"><%= flash.msg %></div>
  <% } else if (typeof locals.flash !== 'undefined' && locals.flash) { %>
    <div class="flash flash-<%= locals.flash.type %>"><%= locals.flash.msg %></div>
  <% } %>

  <h1 class="page-title">Tasks</h1>
  <p class="muted"><%= doneCount %> of <%= totalCount %> complete</p>

  <% if (tasks.length === 0) { %>
    <p class="muted">No tasks have been posted yet. Check back soon!</p>
  <% } else { %>
    <ul class="task-list">
      <% tasks.forEach(function (t) { %>
        <li class="task-row <%= t.done ? 'task-done' : 'task-todo' %>">
          <a class="task-link" href="/tasks/<%= t.id %>">
            <span class="task-thumb-wrap">
              <% if (t.done && t.thumb_path) { %>
                <img src="/thumbs/<%= t.thumb_path %>" alt="" class="task-thumb" />
              <% } else { %>
                <span class="task-thumb-empty" aria-hidden="true">📷</span>
              <% } %>
            </span>
            <span class="task-body">
              <span class="task-title-text"><%= t.title %></span>
              <% if (t.description) { %>
                <span class="task-desc"><%= t.description %></span>
              <% } %>
            </span>
            <span class="task-state">
              <% if (t.done) { %>
                <span class="badge-done" aria-label="Completed">✓ Done</span>
              <% } else { %>
                <span class="badge-todo" aria-label="Not done">To do</span>
              <% } %>
            </span>
          </a>
        </li>
      <% }); %>
    </ul>
  <% } %>

  <p class="back-link"><a href="/">← Back to my garden</a></p>

</main>

<%- include('partials/footer') %>
```

---

## Step 6 — Create the view: `src/views/task.ejs`

One task plus the upload form. If a submission already exists, it's shown and the button text changes to "Replace photo". The form posts multipart to `/tasks/:id/submit` with a single file field named **`photo`** and an optional **`caption`**.

```html
<!-- src/views/task.ejs -->
<%- include('partials/head', { title: title }) %>
<%- include('partials/header') %>

<main class="page page-task">

  <% if (typeof flash !== 'undefined' && flash) { %>
    <div class="flash flash-<%= flash.type %>"><%= flash.msg %></div>
  <% } else if (typeof locals.flash !== 'undefined' && locals.flash) { %>
    <div class="flash flash-<%= locals.flash.type %>"><%= locals.flash.msg %></div>
  <% } %>

  <p class="back-link"><a href="/tasks">← All tasks</a></p>

  <h1 class="page-title"><%= task.title %></h1>
  <% if (task.description) { %>
    <p class="task-detail-desc"><%= task.description %></p>
  <% } %>

  <% if (submission) { %>
    <section class="existing-submission">
      <h2 class="section-title">Your photo</h2>
      <img src="/uploads/<%= submission.photo_path %>"
           alt="Your submitted photo for <%= task.title %>"
           class="submission-full" />
      <% if (submission.caption) { %>
        <p class="submission-caption"><%= submission.caption %></p>
      <% } %>
      <p class="muted">This task is complete. You can replace your photo below.</p>
    </section>
  <% } %>

  <section class="upload-section">
    <h2 class="section-title"><%= submission ? 'Replace your photo' : 'Upload a photo to complete this task' %></h2>

    <form action="/tasks/<%= task.id %>/submit"
          method="POST"
          enctype="multipart/form-data"
          class="upload-form">

      <div class="form-row">
        <label for="photo" class="form-label">Choose a photo</label>
        <input type="file"
               id="photo"
               name="photo"
               accept="image/*"
               capture="environment"
               required
               class="file-input" />
      </div>

      <!-- Live preview target; filled by /js/upload.js -->
      <div class="preview-wrap">
        <img id="upload-preview" class="upload-preview" alt="" hidden />
      </div>

      <div class="form-row">
        <label for="caption" class="form-label">Caption (optional)</label>
        <input type="text"
               id="caption"
               name="caption"
               maxlength="500"
               placeholder="Say something about this photo"
               value="<%= submission ? submission.caption : '' %>"
               class="text-input" />
      </div>

      <button type="submit" class="btn btn-primary">
        <%= submission ? 'Replace photo' : 'Upload & complete' %>
      </button>
    </form>
  </section>

  <!-- Direct include of the preview script (belt-and-suspenders alongside
       the footer's page-script mechanism; see section intro note). -->
  <script src="/js/upload.js" defer></script>

</main>

<%- include('partials/footer') %>
```

---

## Step 7 — Create the view: `src/views/me-edit.ejs`

Edit name, avatar, and social links. Same form posts multipart so the avatar can be a file. The avatar field is **also named `photo`** because the router reuses the same multer single-file middleware. The social fields are **`instagram`, `facebook`, and `website`** — the same key set used at onboarding (section 03) and recognized by `parseSocialLinks` (section 07), so nothing entered at onboarding silently disappears when a guest saves here.

```html
<!-- src/views/me-edit.ejs -->
<%- include('partials/head', { title: title }) %>
<%- include('partials/header') %>

<main class="page page-me-edit">

  <% if (typeof flash !== 'undefined' && flash) { %>
    <div class="flash flash-<%= flash.type %>"><%= flash.msg %></div>
  <% } else if (typeof locals.flash !== 'undefined' && locals.flash) { %>
    <div class="flash flash-<%= locals.flash.type %>"><%= locals.flash.msg %></div>
  <% } %>

  <p class="back-link"><a href="/">← Back to my garden</a></p>
  <h1 class="page-title">Edit My Profile</h1>

  <form action="/me/edit"
        method="POST"
        enctype="multipart/form-data"
        class="edit-form">

    <div class="form-row">
      <label for="name" class="form-label">Display name</label>
      <input type="text"
             id="name"
             name="name"
             maxlength="80"
             value="<%= guest.name %>"
             class="text-input" />
    </div>

    <div class="form-row">
      <label class="form-label">Current avatar</label>
      <div class="avatar-current">
        <% if (guest.avatar_path) { %>
          <img src="/uploads/<%= guest.avatar_path %>" alt="Your current avatar" class="avatar-img" />
        <% } else { %>
          <div class="avatar-placeholder" aria-hidden="true">🌸</div>
        <% } %>
      </div>
    </div>

    <div class="form-row">
      <label for="photo" class="form-label">Change avatar (optional)</label>
      <input type="file"
             id="photo"
             name="photo"
             accept="image/*"
             class="file-input" />
    </div>

    <div class="preview-wrap">
      <img id="upload-preview" class="upload-preview" alt="" hidden />
    </div>

    <fieldset class="socials-fieldset">
      <legend>Social links (optional)</legend>

      <div class="form-row">
        <label for="instagram" class="form-label">Instagram handle or URL</label>
        <input type="text"
               id="instagram"
               name="instagram"
               maxlength="200"
               value="<%= social.instagram ? social.instagram : '' %>"
               placeholder="@yourhandle"
               class="text-input" />
      </div>

      <div class="form-row">
        <label for="facebook" class="form-label">Facebook</label>
        <input type="text"
               id="facebook"
               name="facebook"
               maxlength="200"
               value="<%= social.facebook ? social.facebook : '' %>"
               placeholder="facebook.com/you"
               class="text-input" />
      </div>

      <div class="form-row">
        <label for="website" class="form-label">Website</label>
        <input type="text"
               id="website"
               name="website"
               maxlength="200"
               value="<%= social.website ? social.website : '' %>"
               placeholder="https://example.com"
               class="text-input" />
      </div>
    </fieldset>

    <button type="submit" class="btn btn-primary">Save profile</button>
  </form>

  <!-- Direct include of the preview script (see section intro note). -->
  <script src="/js/upload.js" defer></script>

</main>

<%- include('partials/footer') %>
```

---

## Step 8 — Create the client preview script: `src/public/js/upload.js`

Pure vanilla JS, no framework. It finds the file input (`#photo`) and the preview `<img id="upload-preview">`, and when the guest picks an image it shows a preview using `URL.createObjectURL`. It guards against the elements not existing (so it's harmless on pages without an upload form).

```javascript
// src/public/js/upload.js
(function () {
  'use strict';

  function init() {
    var input = document.getElementById('photo');
    var preview = document.getElementById('upload-preview');

    if (!input || !preview) {
      return; // No upload form on this page.
    }

    var lastObjectUrl = null;

    input.addEventListener('change', function () {
      // Clean up any previous object URL to avoid memory leaks.
      if (lastObjectUrl) {
        URL.revokeObjectURL(lastObjectUrl);
        lastObjectUrl = null;
      }

      var file = input.files && input.files[0];
      if (!file) {
        preview.hidden = true;
        preview.removeAttribute('src');
        return;
      }

      // Only preview image files.
      if (file.type && file.type.indexOf('image/') !== 0) {
        preview.hidden = true;
        preview.removeAttribute('src');
        return;
      }

      lastObjectUrl = URL.createObjectURL(file);
      preview.src = lastObjectUrl;
      preview.hidden = false;
      preview.alt = 'Preview of the photo you selected';
    });
  }

  // The script is loaded with defer, but guard anyway for safety.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
```

---

## Step 9 — A note on the `socials` display elsewhere

This section only lets the guest **edit** their social links. Showing them off on the **public** profile (`/u/:guestId`) is owned by section 07. You don't need to do anything here for that — the JSON you save in `guests.social_links` is exactly what section 07 reads. The keys you write are **`instagram`, `facebook`, and `website`** — the same key set used by section 03's onboarding form and recognized by section 07's `parseSocialLinks`. The POST handler above **preserves** any other keys already present in the stored JSON (it only overwrites the three it renders), so a link saved elsewhere is never silently dropped. If you add a key here, make sure `parseSocialLinks` (section 07) has a label and a sensible link type for it.

---

## Acceptance check

Do these steps **after** sections 01–03, 05, and 06 are built (the guest router imports the photos and scoring services and the `requireGuest` middleware). If 05/06 are not yet built, you can still confirm the files parse (step A) but cannot run the upload/scoring flows.

**A. Files parse (no syntax errors).** From the project root in PowerShell:

```powershell
node --check .\src\routes\guest.js
node --check .\src\public\js\upload.js
```

Expected: both commands print nothing and exit with code 0 (no output = success). If you see a `SyntaxError`, fix the typo at the reported line.

**B. Start the app and sign in as a guest.** With everything built and the admin password set + DB seeded (sections 01/02), start the server:

```powershell
npm start
```

In a browser, open a valid guest link (from the admin QR sheet or a token you created), e.g. `http://localhost:3000/j/<token>`. Finish onboarding if prompted. You should land on `GET /` — your **My Garden** page.

Expected on `GET /`:
- Your name and **0 points** (if you've done nothing yet).
- A progress section reading "5 more tasks to your next badge (at 5 tasks)" and an empty progress bar.
- "My Badges" shows "No badges yet…".
- "My Photos" shows "You haven't uploaded any photos yet."

**C. Task list.** Click **View all tasks** (or go to `/tasks`). Expected: every active task is listed, each marked **To do**, and a counter "0 of N complete".

**D. Upload a photo.** Click a task → you're on `/tasks/:id`. Choose a photo from your phone/computer.
- Expected: a **live preview image appears immediately** below the file input (that's `upload.js` working — and no `/js//js/upload.js` 404 in the dev console, confirming `pageScript` is a bare filename).
- Type an optional caption, click **Upload & complete**.
- Expected: you're redirected back to `/tasks/:id`, a green **"Task complete! +1 point."** flash appears (rendered from `res.locals.flash` as `{ type:'ok', msg:'...' }`), your uploaded photo is shown under "Your photo", and the button now reads **Replace photo**. Reloading the page does NOT show the flash again (it was cleared by `attachGuest`).

**E. Completion + scoring reflected.** Go back to `/`.
- Expected: points now show **1**, "1 of N tasks complete", the progress bar moved, and "My Photos" shows your thumbnail labeled with the task title.

**F. Replace a photo.** Return to that task, choose a different photo, submit.
- Expected: a **"Photo replaced!"** flash, the new photo shown, and points stay at **1** (replacing doesn't add a second point — the `UNIQUE(guest_id, task_id)` constraint means one submission per task). The old original + thumbnail files are deleted from disk.

**G. Auto badge.** Complete 5 different tasks (upload a photo for each). After the 5th:
- Expected (driven by section 06's `recomputeAutoBadges`): on `/`, the **First Bloom** badge (art from `/badges/bloom.svg`) now appears under "My Badges", and the progress text advances toward the next threshold (10).

**H. Edit profile.** Go to `/me/edit`. Change your display name, optionally pick a new avatar (preview should appear), fill in an Instagram handle, a Facebook link, and a website, click **Save profile**.
- Expected: redirect to `/` with a **"Profile updated!"** flash, your new name shown, and (if you picked one) your new avatar. Reopening `/me/edit` shows the Instagram, Facebook, and website values pre-filled (confirming they were saved into `guests.social_links` as JSON). Any social key set at onboarding but not edited here is still present after saving (the handler preserves unknown keys).

**I. Auth guard.** Open a private/incognito window with no guest cookie and visit `http://localhost:3000/`.
- Expected: `requireGuest` redirects you to the "link required" page (section 03) — you do **not** see someone else's garden.

If all of A–I behave as described, section 04 is complete.
