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
// thumbnail filename. saveAvatar(buffer, guestId) is ASYNC, writes the avatar
// file, sets guests.avatar_path, and returns the filename. deleteOriginalFile()
// and deleteThumbFile() remove files from disk.
const photos = require('../services/photos');

// Scoring service (section 06) — REAL exports only.
const scoring = require('../services/scoring');

// Submission-intake service (issue #106) — owns the whole submit-or-replace
// sequence for POST /tasks/:id/submit: task-active check, thumbnail, upsert,
// caption normalization, and scoring recompute. This route calls it once and
// maps the returned status to a response; see the handler below.
const submissions = require('../services/submissions');

// Numeric auto-badge thresholds derived from the {code,n} catalog.
// e.g. BADGE_THRESHOLDS = [{code:'BLOOM',n:5},{code:'BOUQUET',n:10},{code:'GARDEN',n:15}]
// -> AUTO_THRESHOLDS = [5, 10, 15]
const AUTO_THRESHOLDS = scoring.BADGE_THRESHOLDS.map(function (t) {
  return t.n;
}).sort(function (a, b) {
  return a - b;
});

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
// Shows: points, badges (with art), completed vs total tasks, and a
// progress bar toward the next auto badge.
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
        try {
          fs.unlinkSync(req.file.path);
        } catch (e2) {
          /* non-fatal */
        }
        setFlash(res, 'error', 'Sorry, we could not save that avatar. Please try again.');
        return res.redirect('/me/edit');
      }
      // Drop the raw multer upload now that saveAvatar made its own copy.
      try {
        fs.unlinkSync(req.file.path);
      } catch (e2) {
        /* non-fatal */
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
