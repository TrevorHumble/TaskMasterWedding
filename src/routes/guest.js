// src/routes/guest.js
'use strict';

const express = require('express');
const router = express.Router();

// db.js exports an OBJECT { db, getGuestByToken, getGuestById }. Destructure the
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
// thumbnail filename.
// `uploadAvatar` is the multer MEMORY-storage middleware ALREADY BOUND to
// single('avatar') (issue #122) — call it directly the same way. After it runs,
// req.file.buffer holds the raw bytes (no req.file.path on this path).
// saveAvatar(buffer, guestId) is ASYNC, writes the avatar file, sets
// guests.avatar_path, and returns the filename. deleteOriginalFile() and
// deleteThumbFile() remove files from disk.
const photos = require('../services/photos');

// Scoring service (section 06) — REAL exports only.
const scoring = require('../services/scoring');

// Submission-intake service (issue #106) — owns the whole submit-or-replace
// sequence for POST /tasks/:id/submit: task-active check, thumbnail, upsert,
// caption normalization, and scoring recompute. This route calls it once and
// maps the returned status to a response; see the handler below.
const submissions = require('../services/submissions');

// ---------------------------------------------------------------------------
// Small local helper: set a one-shot flash message.
// Section 03's attachGuest reads the signed `flash` cookie into
// res.locals.flash on the NEXT request, then clears it. We write it here.
// kind is 'success' or 'error'; text is the message. We normalize to the
// shape header.ejs (section 10) reads: { type: 'ok' | 'err', msg: '...' }.
// ---------------------------------------------------------------------------
function setFlash(res, kind, text) {
  const type = kind === 'success' ? 'ok' : 'err';
  res.cookie('flash', JSON.stringify({ type: type, msg: text }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    signed: true,
    path: '/',
    maxAge: 30 * 1000, // 30 seconds is plenty to survive one redirect
  });
}

// Every route in this router requires a signed-in guest.
router.use(requireGuest);

// ---------------------------------------------------------------------------
// GET /  — the guest's own home / profile page.
// Shows: points, badges (with art), and a task-completion progress bar
// (completed tasks vs total active tasks).
// ---------------------------------------------------------------------------
router.get('/', function (req, res) {
  const guest = res.locals.guest;

  // Total active tasks (guests only ever see active tasks).
  const totalActiveRow = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE is_active = 1').get();
  const totalTasks = totalActiveRow.n;

  // Completed tasks for this guest — routed through scoring.getCompletedCount
  // (issue #104) so this count can never drift from points and badges, which
  // use the same canonical rule (visible submissions, no is_active filter).
  const completedTasks = scoring.getCompletedCount(guest.id);

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

  // Progress bar reflects task completion (X of Y), not badge thresholds —
  // the "next badge" framing was removed because it contradicted this bar
  // whenever the highest badge threshold was unreachable given the active
  // task count (see issue #88).
  //
  // Clamp to [0,100]: completedTasks uses the canonical count (visible
  // submissions, NO is_active filter) while totalTasks counts only active
  // tasks, so a guest who completed a task the admin later deactivated can
  // have completedTasks > totalTasks. Without the clamp that overflows the
  // bar's width and pushes aria-valuenow past aria-valuemax="100".
  const progressPercent =
    totalTasks === 0
      ? 0
      : Math.max(0, Math.min(100, Math.round((completedTasks / totalTasks) * 100)));

  res.render('guest-home', {
    title: 'My Garden',
    points: points,
    badges: badges,
    submissions: submissions,
    totalTasks: totalTasks,
    completedTasks: completedTasks,
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

  const doneCount = tasks.filter(function (t) {
    return t.done === 1;
  }).length;

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
// and req.file.path its absolute path on disk. Everything past "we have a
// file" — task-active check, thumbnail, insert-or-replace, caption, scoring
// recompute — is one call to submissions.submitPhoto (issue #106); this
// handler only owns what needs req/res: running multer, the multer-error and
// missing-file branches, and mapping the returned status to a response.
// ---------------------------------------------------------------------------
router.post('/tasks/:id/submit', function (req, res) {
  // Run multer first; it may error (file too big, wrong type, no file).
  // photos.upload is the ALREADY-BOUND single('photo') middleware (section 05),
  // so call it directly. The callback is async because submitPhoto is async.
  photos.upload(req, res, async function (err) {
    const guest = res.locals.guest;
    const taskId = Number(req.params.id);

    if (!Number.isInteger(taskId) || taskId <= 0) {
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

    const result = await submissions.submitPhoto({
      guestId: guest.id,
      taskId: taskId,
      file: req.file,
      caption: req.body.caption,
    });

    if (result.status === 'task_inactive') {
      return res.status(404).render('404', { title: 'Not found' });
    }
    if (result.status === 'thumb_failed') {
      setFlash(res, 'error', 'Sorry, we could not save that photo. Please try again.');
      return res.redirect('/tasks/' + taskId);
    }

    setFlash(
      res,
      'success',
      result.status === 'replaced' ? 'Photo replaced!' : 'Task complete! +1 point.'
    );
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
  let social;
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
// Avatar uses the SAME memory-storage `uploadAvatar` middleware (field name
// "avatar") as onboarding (issue #122), so req.file.buffer is already the raw
// bytes — no disk read-back/unlink needed. We call photos.saveAvatar(buffer,
// guestId) (async; it sets avatar_path) and remove a replaced avatar with
// deleteOriginalFile. No thumbnail, no submission row.
// ---------------------------------------------------------------------------
router.post('/me/edit', function (req, res) {
  // photos.uploadAvatar is the ALREADY-BOUND single('avatar') MEMORY-storage
  // middleware (section 05). The callback is async because saveAvatar() is async.
  photos.uploadAvatar(req, res, async function (err) {
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

    // Optional new avatar. photos.uploadAvatar (memory storage, field "avatar")
    // already gives us req.file.buffer directly — hand it straight to
    // saveAvatar(buffer, guestId), which writes the stored avatar file, sets
    // guests.avatar_path, and returns the filename. No temp file to read back
    // or clean up.
    let newAvatarPath = guest.avatar_path; // keep existing unless replaced
    if (req.file) {
      let savedAvatar;
      try {
        savedAvatar = await photos.saveAvatar(req.file.buffer, guest.id); // stored filename
      } catch (e) {
        setFlash(res, 'error', 'Sorry, we could not save that avatar. Please try again.');
        return res.redirect('/me/edit');
      }

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

    db.prepare('UPDATE guests SET name = ?, avatar_path = ?, social_links = ? WHERE id = ?').run(
      name,
      newAvatarPath,
      socialJson,
      guest.id
    );

    setFlash(res, 'success', 'Profile updated!');
    return res.redirect('/');
  });
});

module.exports = router;
