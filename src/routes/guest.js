// src/routes/guest.js
'use strict';

const express = require('express');
const router = express.Router();

// db.js exports an OBJECT { db, getGuestByToken, getGuestById }. Destructure the
// better-sqlite3 connection itself, or db.prepare(...) is undefined.
const { db } = require('../db');

// requireGuest comes from section 03. It loads the current guest into
// res.locals.guest (and req.guest) from the signed gsid cookie, or
// redirects visitors who have no valid guest link. setFlash is the shared
// one-shot flash writer (also in section 03), the single owner of the signed
// `flash` cookie's shape.
const { requireGuest, setFlash } = require('../middleware/session');

// isValidPin (issue #243) — the SAME 4-digit-shape rule signup (routes/auth.js)
// and the admin identity route (routes/admin.js) already share from
// services/identity.js. POST /me/edit below calls this single owner rather
// than re-encoding the shape rule a third time.
const { isValidPin } = require('../services/identity');

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

// Memory-upload abuse guardrails (issue #247). config (required above) owns
// MEMORY_RATE_MAX / MEMORY_RATE_WINDOW_MS / MIN_FREE_DISK_BYTES; the rate-limit
// service owns the per-guest limiter and the injectable free-space reader.
// Applied only to POST /memories below.
const rateLimit = require('../services/rate-limit');

// Copy shown when a guest is over the memory rate limit (AC11) or the data
// volume is below MIN_FREE_DISK_BYTES (AC12). Kept as named constants so the
// route and the tests reference the same literal in one place.
const MEMORY_RATE_LIMIT_MESSAGE =
  "Whoa — that's a lot of memories at once. Give it a minute and try again.";
const MEMORY_DISK_FULL_MESSAGE = 'The gallery is full right now — please tell the hosts.';

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
  // task title so we can label each thumbnail on the home page. LEFT JOIN
  // (not JOIN): a memory (issue #247, task_id IS NULL) has no task row to
  // join, and must still appear in My Photos with task_title coming back
  // NULL — the view falls back to the memory's own caption instead (AC8).
  const submissions = db
    .prepare(
      `SELECT s.id, s.task_id, s.photo_path, s.thumb_path, s.caption,
              s.created_at, t.title AS task_title
         FROM submissions s
         LEFT JOIN tasks t ON t.id = s.task_id
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
  // s.created_at orders the "most recent completions" strip on the default view.
  const tasks = db
    .prepare(
      `SELECT t.id, t.title, t.description, t.sort_order,
              CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END AS done,
              s.thumb_path AS thumb_path,
              s.created_at AS done_at
         FROM tasks t
         LEFT JOIN submissions s
                ON s.task_id = t.id
               AND s.guest_id = ?
               AND s.taken_down = 0
        WHERE t.is_active = 1
        ORDER BY t.sort_order ASC, t.id ASC`
    )
    .all(guest.id);

  const todoTasks = tasks.filter(function (t) {
    return t.done !== 1;
  });
  // Done tasks, most recent completion first — the default view shows the top 3
  // of this list; ?view=done shows all of it.
  const doneTasks = tasks
    .filter(function (t) {
      return t.done === 1;
    })
    .sort(function (a, b) {
      return String(b.done_at || '').localeCompare(String(a.done_at || ''));
    });

  res.render('tasks', {
    title: 'Tasks',
    view: req.query.view === 'done' ? 'done' : 'todo',
    todoTasks: todoTasks,
    doneTasks: doneTasks,
    recentDone: doneTasks.slice(0, 3),
    doneCount: doneTasks.length,
    todoCount: todoTasks.length,
    totalCount: tasks.length,
    pointsPerPhoto: scoring.POINTS_PER_PHOTO,
  });
});

// ---------------------------------------------------------------------------
// GET /how-to-play  — the one-screen rules card (issue #246). Reachable from
// the profile menu (a plain GET, no query string). ?first=1 (still honored
// via req.query.first below) shows the "Skip for now" link for a guest
// mid-first-run; nothing currently redirects here with it since #244 retired
// the separate /onboard step that used to.
//
// taskCount is the LIVE count of active tasks (owner directive: never a
// hard-coded number, so the copy tracks admin changes to the task list).
// firstTaskHref points at this guest's own lowest-sort_order undone task —
// the same "todo, ordered by sort_order" shape /tasks already computes above,
// just narrowed to id-only and LIMIT 1 here since this route only needs the
// first row, not the whole list.
// ---------------------------------------------------------------------------
router.get('/how-to-play', function (req, res) {
  const guest = res.locals.guest;

  const taskCountRow = db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE is_active = 1').get();
  const taskCount = taskCountRow.n;

  // Lowest sort_order active task this guest has not (visibly) submitted for.
  // taken_down submissions do not count as done, matching /tasks above.
  const firstUndone = db
    .prepare(
      `SELECT t.id
         FROM tasks t
         LEFT JOIN submissions s
                ON s.task_id = t.id
               AND s.guest_id = ?
               AND s.taken_down = 0
        WHERE t.is_active = 1
          AND s.id IS NULL
        ORDER BY t.sort_order ASC, t.id ASC
        LIMIT 1`
    )
    .get(guest.id);

  res.render('how-to-play', {
    title: 'How to play',
    taskCount: taskCount,
    firstTaskHref: firstUndone ? '/tasks/' + firstUndone.id : '/tasks',
    showSkip: req.query.first === '1',
  });
});

// Copy shown to the guest after a bug report is stored (AC1) and when the
// body field is left empty (AC5). Named constants so the route and the tests
// reference the same literal in one place.
const BUG_REPORT_THANKS = 'Thanks — the Wedding Masters have been told.';
const BUG_REPORT_EMPTY_ERROR = 'Tell us what went wrong first.';
// A stored bug body is capped at this many characters (issue #245 AC6) — long
// enough for a real description. This bounds only the per-request body
// length, not the number of reports a guest can file; an unbounded report
// count is a known, accepted minor under the guest-comments threat model.
const BUG_REPORT_BODY_MAX = 1000;

// Pull just the path (no scheme/host) out of a Referer header, so
// bug_reports.page never stores a full origin a guest's phone happened to be
// on. Real browsers send an absolute URL; some test/tooling clients send a
// bare path directly, so a same-origin-only relative string is accepted too.
// Returns null when the header is absent or unusable.
function refererPath(rawReferer) {
  if (typeof rawReferer !== 'string' || rawReferer.length === 0) {
    return null;
  }
  try {
    return new URL(rawReferer).pathname;
  } catch (e) {
    return rawReferer.startsWith('/') ? rawReferer : null;
  }
}

// ---------------------------------------------------------------------------
// GET /bug-report  — the "Report a bug" form (issue #245). Guest-gated by the
// router.use(requireGuest) above, same as every other route in this file
// (AC2: a signed-out visitor is redirected to /join instead — issue #241).
// ---------------------------------------------------------------------------
router.get('/bug-report', function (req, res) {
  res.render('bug-report', { title: 'Report a bug', error: '' });
});

// ---------------------------------------------------------------------------
// POST /bug-report  — store a guest's bug report (issue #245).
// The app auto-attaches guest id, the referring path (Referer header, origin
// stripped), and the User-Agent — the guest form itself carries only the
// message body, per the design ("no email field, no screenshot upload").
// ---------------------------------------------------------------------------
router.post('/bug-report', function (req, res) {
  const guest = res.locals.guest;

  const raw = typeof req.body.body === 'string' ? req.body.body : '';
  const trimmed = raw.trim();

  // AC5: an empty (or whitespace-only) body inserts no row and re-renders the
  // form with the required error copy.
  if (trimmed.length === 0) {
    return res.render('bug-report', { title: 'Report a bug', error: BUG_REPORT_EMPTY_ERROR });
  }

  // AC6: truncate to BUG_REPORT_BODY_MAX chars — 1001 'a' characters store as
  // exactly 1000.
  const body = trimmed.slice(0, BUG_REPORT_BODY_MAX);

  const page = refererPath(req.get('referer'));
  const userAgent = req.get('user-agent') || null;

  db.prepare(
    `INSERT INTO bug_reports (guest_id, body, page, user_agent, resolved)
     VALUES (?, ?, ?, ?, 0)`
  ).run(guest.id, body, page, userAgent);

  setFlash(res, 'success', BUG_REPORT_THANKS);
  return res.redirect('/');
});

// ---------------------------------------------------------------------------
// GET /tasks/:id  — one task's detail + the upload form. If the guest has
// already submitted, show their photo (or, if a host took it down, the
// "with the hosts" state — issue #190) and allow replacing it.
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

  // The guest's submission for this task, loaded REGARDLESS of taken_down
  // (issue #190): a host takedown must not make the task page fall back to
  // "not done" and invite a resubmit that would have silently reversed the
  // takedown. task.ejs branches on submission.taken_down to render the
  // "with the hosts" state instead of the ordinary complete state.
  const submission = db
    .prepare(
      `SELECT id, photo_path, thumb_path, caption, created_at, taken_down
         FROM submissions
        WHERE guest_id = ? AND task_id = ?`
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

    // replaced_hidden (issue #190): the resubmit landed on a still-taken-down
    // row, so it does not go live — tell the guest that plainly rather than
    // claiming "Photo replaced!" for something that isn't visible yet.
    let flashMsg = 'Task complete! +1 point.';
    if (result.status === 'replaced') {
      flashMsg = 'Photo replaced!';
    } else if (result.status === 'replaced_hidden') {
      flashMsg = 'Photo received — it will appear once the hosts approve it.';
    }
    setFlash(res, 'success', flashMsg);
    return res.redirect('/tasks/' + taskId);
  });
});

// ---------------------------------------------------------------------------
// GET /memories/new  — the "share a memory" form (issue #247). Guest-gated by
// the router.use(requireGuest) above, same as every other route in this file
// (AC6: a signed-out visitor is redirected to /join instead — issue #241).
// ---------------------------------------------------------------------------
router.get('/memories/new', function (req, res) {
  res.render('memory-new', { title: 'Share a memory' });
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
        return res.render('memory-new', {
          title: 'Share a memory',
          error: 'Ten photos at a time — send the rest in a second batch.',
        });
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

    // Rate-limit guard (AC11). recordMemoryAttempt only consumes the guest's
    // budget when it ALLOWS the attempt, so a rejected batch does not extend
    // the penalty past the real window. Reject before persisting; clean up the
    // originals multer wrote so nothing is left behind.
    const rl = rateLimit.recordMemoryAttempt(guest.id);
    if (!rl.allowed) {
      cleanupBatchOriginals(files);
      return res.render('memory-new', {
        title: 'Share a memory',
        error: MEMORY_RATE_LIMIT_MESSAGE,
      });
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
      return res.render('memory-new', {
        title: 'Share a memory',
        error: MEMORY_DISK_FULL_MESSAGE,
      });
    }

    // Persist the batch. Wrapped so a thrown error routes to the Express error
    // handler (next(err)) rather than becoming an unhandled promise rejection
    // that hangs the request (plan step 9b).
    let result;
    try {
      result = await submissions.submitMemoryBatch({
        guestId: guest.id,
        files: files,
        caption: req.body.caption,
      });
    } catch (batchErr) {
      return next(batchErr);
    }

    // If every file failed to thumbnail, submitMemoryBatch inserts zero rows —
    // do NOT tell the guest the batch was shared when nothing was (plan step
    // 9a). Surface an error instead.
    if (!result.submissionIds || result.submissionIds.length === 0) {
      setFlash(res, 'error', "Sorry, we couldn't save those photos. Please try again.");
      return res.redirect('/memories/new');
    }

    setFlash(res, 'success', "Shared! They're in the gallery.");
    return res.redirect('/gallery');
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

    // Optional new re-entry code (issue #243 AC3/AC4). Empty/absent means
    // "leave the existing pin unchanged" — a guest correcting only their name
    // or avatar must never accidentally wipe a working code. Validated with
    // isValidPin (see the require at top of this file), checked FIRST before
    // any other field is touched, so an invalid pin short-circuits the whole
    // save — nothing (name, avatar, socials, pin) is written — rather than
    // silently saving the rest alongside a rejected pin.
    const rawPin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
    if (rawPin && !isValidPin(rawPin)) {
      setFlash(res, 'error', 'Please choose a 4-digit PIN (numbers only).');
      return res.redirect('/me/edit');
    }
    const newPin = rawPin ? rawPin : guest.pin; // blank submitted -> keep existing

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

    db.prepare(
      'UPDATE guests SET name = ?, avatar_path = ?, social_links = ?, pin = ? WHERE id = ?'
    ).run(name, newAvatarPath, socialJson, newPin, guest.id);

    setFlash(res, 'success', 'Profile updated!');
    return res.redirect('/');
  });
});

module.exports = router;
