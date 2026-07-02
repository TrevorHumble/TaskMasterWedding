// src/routes/admin.js
// Admin router. Every route here is behind requireAdmin (applied below).
// Routes:
//   GET  /admin                          dashboard
//   GET  /admin/guests                   guests table + add/bulk forms
//   POST /admin/guests                   create one guest
//   POST /admin/guests/bulk              create N guests
//   POST /admin/guests/:id/edit          rename a guest
//   POST /admin/guests/:id/delete        delete a guest (cascades submissions/badges; deletes photo files)
//   POST /admin/guests/:id/points        award bonus points (scoring.addBonusPoints)
//   POST /admin/guests/:id/badge         award OR remove a special badge
//   GET  /admin/qrsheet                  printable QR place-card sheet
//   GET  /admin/tasks                    task list + add form
//   POST /admin/tasks                    create a task
//   POST /admin/tasks/:id/edit           edit a task title/description
//   POST /admin/tasks/:id/delete         delete a task (cascades submissions)
//   POST /admin/tasks/:id/active         toggle is_active
//   POST /admin/tasks/reorder            move a task up/down (sort_order)
//   GET  /admin/photos                   ALL submissions incl. taken-down
//   POST /admin/photos/:id/takedown      hide a photo + recompute auto-badges
//   POST /admin/photos/:id/restore       unhide a photo + recompute auto-badges
//   GET  /admin/export                   defined in 09-export (see ADD-THIS there)
//
// NOTE: GET/POST /admin/login and POST /admin/logout live in 03-auth (routes/auth.js).
//       Do NOT define them here.

const express = require('express');
const crypto = require('crypto');

const config = require('../../config');
const { db } = require('../db');
const { requireAdmin } = require('../middleware/session');
const qr = require('../services/qr');
const scoring = require('../services/scoring');
const photos = require('../services/photos');
const { streamExportZip } = require('../services/export');

const router = express.Router();

// Guard the whole router. Section 03's requireAdmin redirects to /admin/login
// when the signed admin cookie is not "1".
router.use(requireAdmin);

// Mark every admin page as an admin context so partials/header.ejs renders the
// ADMIN nav (Dashboard/Tasks/Guests/Photos/QR Sheet/Log out) and the logout
// button, instead of the GUEST nav. Set once here so no individual res.render
// has to remember to pass isAdmin.
router.use((req, res, next) => {
  res.locals.isAdmin = true;
  next();
});

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

// Build a redirect target with a human message in the ?msg= query.
function redirectWithMsg(res, path, msg) {
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  res.redirect(303, path + sep + 'msg=' + encodeURIComponent(msg));
}

// Generate a unique 32-hex-char token (crypto.randomBytes(16) -> 32 hex chars).
// Loops on the extremely unlikely chance of a collision with an existing token.
function makeUniqueToken() {
  const exists = db.prepare('SELECT 1 FROM guests WHERE token = ?');
  for (let i = 0; i < 10; i++) {
    const token = crypto.randomBytes(16).toString('hex');
    if (!exists.get(token)) {
      return token;
    }
  }
  // Practically unreachable.
  throw new Error('Could not generate a unique guest token.');
}

// ---------------------------------------------------------------------------
// GET /admin  — dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const counts = {
    guests: db.prepare('SELECT COUNT(*) AS n FROM guests').get().n,
    tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    activeTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE is_active = 1').get().n,
    submissions: db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    livePhotos: db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 0').get().n,
    takenDown: db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 1').get().n,
    badgesAwarded: db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n,
  };

  res.render('admin-dashboard', {
    title: 'Admin Dashboard',
    counts,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/guests  — table of guests + add form + bulk form
// ---------------------------------------------------------------------------
router.get('/guests', (req, res) => {
  const guests = db.prepare('SELECT * FROM guests ORDER BY created_at ASC, id ASC').all();

  // List of special badges so the per-guest award control can offer them.
  const specialBadges = db
    .prepare("SELECT * FROM badges WHERE type = 'special' ORDER BY name ASC")
    .all();

  // For each guest, attach link, points, completed count, and held badge codes.
  const heldStmt = db.prepare(
    `SELECT b.code FROM guest_badges gb
       JOIN badges b ON b.id = gb.badge_id
      WHERE gb.guest_id = ?`
  );
  const rows = guests.map((g) => {
    const held = heldStmt.all(g.id).map((r) => r.code);
    return {
      id: g.id,
      name: g.name || '',
      token: g.token,
      link: config.BASE_URL.replace(/\/+$/, '') + '/j/' + g.token,
      bonus_points: g.bonus_points,
      points: scoring.getPoints(g.id),
      completed: scoring.getCompletedCount(g.id),
      heldCodes: held,
    };
  });

  res.render('admin-guests', {
    title: 'Guests',
    guests: rows,
    specialBadges,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/guests  — create a single guest (optionally with a name)
router.post('/guests', (req, res) => {
  const name = (req.body.name || '').trim();
  const token = makeUniqueToken();
  db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)').run(token, name);
  redirectWithMsg(res, '/admin/guests', 'Guest created.');
});

// POST /admin/guests/bulk  — create N empty guests, each with a random token
router.post('/guests/bulk', (req, res) => {
  let n = parseInt(req.body.count, 10);
  if (isNaN(n) || n < 1) {
    return redirectWithMsg(res, '/admin/guests', 'Enter a number of guests of 1 or more.');
  }
  if (n > 500) {
    n = 500; // sanity cap; wedding is ~100 guests
  }
  const insert = db.prepare('INSERT INTO guests (token, name) VALUES (?, ?)');
  // Wrap the loop in a transaction for speed and atomicity.
  const insertMany = db.transaction((howMany) => {
    for (let i = 0; i < howMany; i++) {
      insert.run(makeUniqueToken(), '');
    }
  });
  insertMany(n);
  redirectWithMsg(res, '/admin/guests', 'Created ' + n + ' guest(s).');
});

// POST /admin/guests/:id/edit  — rename a guest
router.post('/guests/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  db.prepare('UPDATE guests SET name = ? WHERE id = ?').run(name, id);
  redirectWithMsg(res, '/admin/guests', 'Guest updated.');
});

// POST /admin/guests/:id/delete  — delete a guest. The FK cascade removes their
// submission rows and badge rows, but it does NOT touch the image files on disk.
// To keep disk and DB in sync (and avoid orphaned originals + thumbs that no
// export will ever pick up), we hard-delete each of the guest's photo files
// BEFORE deleting the guest. This is irreversible — the confirm dialog in the
// view warns the operator.
router.post('/guests/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }

  // Collect this guest's submissions so we can remove their files from disk.
  const subs = db.prepare('SELECT id FROM submissions WHERE guest_id = ?').all(id);
  for (const sub of subs) {
    try {
      // Removes the original photo file AND its thumbnail from disk (section 05).
      // If your photos service names this differently (e.g. deleteOriginalFile +
      // deleteThumbFile), call those instead.
      photos.hardDelete(sub.id);
    } catch (err) {
      // Don't abort the whole delete just because one stray file was already
      // gone; log and continue so the DB row still gets removed.
      console.error('Failed to delete files for submission', sub.id, err);
    }
  }

  // Now remove the guest; FK cascade clears submissions + guest_badges rows.
  db.prepare('DELETE FROM guests WHERE id = ?').run(id);
  redirectWithMsg(res, '/admin/guests', 'Guest and their photos deleted.');
});

// POST /admin/guests/:id/points  — add (or subtract) bonus points
router.post('/guests/:id/points', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const delta = parseInt(req.body.delta, 10);
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  if (isNaN(delta) || delta === 0) {
    return redirectWithMsg(res, '/admin/guests', 'Enter a non-zero point amount.');
  }
  // scoring.addBonusPoints is additive (bonus_points = bonus_points + delta).
  // It does NOT clamp at 0 (per section 06), so a large negative delta can drive
  // a guest's bonus below zero. The admin sees the running total in the UI.
  scoring.addBonusPoints(id, delta);
  redirectWithMsg(
    res,
    '/admin/guests',
    (delta > 0 ? 'Awarded ' : 'Removed ') + Math.abs(delta) + ' bonus point(s).'
  );
});

// POST /admin/guests/:id/badge  — award OR remove a special badge.
// Body: code = badge code (EARLYBIRD/SHUTTERBUG/CROWDFAV/CHOICE),
//       action = "award" or "remove".
router.post('/guests/:id/badge', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const code = (req.body.code || '').trim().toUpperCase();
  const action = (req.body.action || 'award').trim();

  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  const badge = db.prepare("SELECT * FROM badges WHERE code = ? AND type = 'special'").get(code);
  if (!badge) {
    return redirectWithMsg(res, '/admin/guests', 'Unknown special badge.');
  }

  if (action === 'remove') {
    scoring.removeSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Removed badge "' + badge.name + '".');
  } else {
    scoring.awardSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Awarded badge "' + badge.name + '".');
  }
});

// ---------------------------------------------------------------------------
// GET /admin/qrsheet  — printable place-card sheet (name + QR per guest)
// ---------------------------------------------------------------------------
router.get('/qrsheet', async (req, res, next) => {
  try {
    const guests = db.prepare('SELECT * FROM guests ORDER BY name ASC, id ASC').all();

    const base = config.BASE_URL.replace(/\/+$/, '');
    const cards = [];
    for (const g of guests) {
      const link = base + '/j/' + g.token;
      // qr.qrDataUrl returns a PNG data-URI string we can drop into <img src>.
      // (Section 03 exports qrDataUrl, NOT toDataURL.)
      const dataUri = await qr.qrDataUrl(link);
      cards.push({
        name: g.name && g.name.length ? g.name : 'Guest #' + g.id,
        link,
        qr: dataUri,
      });
    }

    res.render('admin-qrsheet', {
      title: 'QR Place-Card Sheet',
      cards,
      baseUrl: base,
      isAdmin: true,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /admin/tasks  — list + add form
// ---------------------------------------------------------------------------
router.get('/tasks', (req, res) => {
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY sort_order ASC, id ASC').all();

  // Attach how many live submissions each task has (informational).
  const subStmt = db.prepare(
    'SELECT COUNT(*) AS n FROM submissions WHERE task_id = ? AND taken_down = 0'
  );
  const rows = tasks.map((t, idx) => ({
    id: t.id,
    title: t.title,
    description: t.description || '',
    sort_order: t.sort_order,
    is_active: t.is_active,
    submissions: subStmt.get(t.id).n,
    isFirst: idx === 0,
    isLast: idx === tasks.length - 1,
  }));

  res.render('admin-tasks', {
    title: 'Tasks',
    tasks: rows,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/tasks  — create a task. New task goes to the bottom of the order.
router.post('/tasks', (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  if (!title) {
    return redirectWithMsg(res, '/admin/tasks', 'A task needs a title.');
  }
  const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM tasks').get();
  const nextOrder = (maxRow.m == null ? -1 : maxRow.m) + 1;
  db.prepare(
    'INSERT INTO tasks (title, description, sort_order, is_active) VALUES (?, ?, ?, 1)'
  ).run(title, description, nextOrder);
  redirectWithMsg(res, '/admin/tasks', 'Task added.');
});

// POST /admin/tasks/:id/edit  — edit title and description
router.post('/tasks/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }
  if (!title) {
    return redirectWithMsg(res, '/admin/tasks', 'A task needs a title.');
  }
  db.prepare('UPDATE tasks SET title = ?, description = ? WHERE id = ?').run(
    title,
    description,
    id
  );
  redirectWithMsg(res, '/admin/tasks', 'Task updated.');
});

// POST /admin/tasks/:id/delete  — delete a task and its photo files.
// ON DELETE CASCADE removes submission rows, but NOT the files on disk.
// Hard-delete each submission's files first so no orphaned originals or
// thumbnails remain (and so direct-URL access is closed — the file is gone).
router.post('/tasks/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);

  // Collect this task's submissions so we can remove their files from disk.
  const subs = db.prepare('SELECT id FROM submissions WHERE task_id = ?').all(id);
  for (const sub of subs) {
    try {
      photos.hardDelete(sub.id);
    } catch (err) {
      // Don't abort the whole delete just because one stray file was already
      // gone; log and continue so the DB row still gets removed.
      console.error('Failed to delete files for submission', sub.id, err);
    }
  }

  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  redirectWithMsg(res, '/admin/tasks', 'Task deleted.');
});

// POST /admin/tasks/:id/active  — toggle visibility to guests
router.post('/tasks/:id/active', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = db.prepare('SELECT is_active FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }
  const next = task.is_active ? 0 : 1;
  db.prepare('UPDATE tasks SET is_active = ? WHERE id = ?').run(next, id);
  redirectWithMsg(
    res,
    '/admin/tasks',
    next ? 'Task is now active.' : 'Task is now hidden from guests.'
  );
});

// POST /admin/tasks/reorder  — move one task up or down by swapping sort_order
// with its neighbor. Body: id = task id, direction = "up" | "down".
router.post('/tasks/reorder', (req, res) => {
  const id = parseInt(req.body.id, 10);
  const direction = (req.body.direction || '').trim();

  const task = db.prepare('SELECT id, sort_order FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }

  let neighbor;
  if (direction === 'up') {
    // The task with the largest sort_order that is still less than this one.
    neighbor = db
      .prepare(
        `SELECT id, sort_order FROM tasks
          WHERE sort_order < ?
          ORDER BY sort_order DESC, id DESC LIMIT 1`
      )
      .get(task.sort_order);
  } else if (direction === 'down') {
    // The task with the smallest sort_order that is still greater than this one.
    neighbor = db
      .prepare(
        `SELECT id, sort_order FROM tasks
          WHERE sort_order > ?
          ORDER BY sort_order ASC, id ASC LIMIT 1`
      )
      .get(task.sort_order);
  } else {
    return redirectWithMsg(res, '/admin/tasks', 'Bad reorder direction.');
  }

  if (!neighbor) {
    // Already at the top or bottom; nothing to do.
    return redirectWithMsg(res, '/admin/tasks', 'Task is already at the edge.');
  }

  // Swap the two sort_order values inside a transaction.
  const swap = db.transaction(() => {
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(neighbor.sort_order, task.id);
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(task.sort_order, neighbor.id);
  });
  swap();
  redirectWithMsg(res, '/admin/tasks', 'Task moved.');
});

// ---------------------------------------------------------------------------
// GET /admin/photos  — ALL submissions, including taken-down ones
// ---------------------------------------------------------------------------
router.get('/photos', (req, res) => {
  const photoRows = db
    .prepare(
      `SELECT s.id          AS id,
              s.photo_path   AS photo_path,
              s.thumb_path   AS thumb_path,
              s.caption      AS caption,
              s.taken_down   AS taken_down,
              s.created_at   AS created_at,
              g.id           AS guest_id,
              g.name         AS guest_name,
              t.title        AS task_title
         FROM submissions s
         JOIN guests g ON g.id = s.guest_id
         JOIN tasks  t ON t.id = s.task_id
        ORDER BY s.created_at DESC, s.id DESC`
    )
    .all();

  res.render('admin-photos', {
    title: 'Photos',
    photos: photoRows,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/photos/:id/takedown  — hide a photo. photos.hideSubmission is the
// single writer of taken_down for moderation: it flips the flag and recomputes
// the guest's auto-badges in one transaction, so a hidden photo can never keep
// counting toward points or auto-badges even for an instant.
router.post('/photos/:id/takedown', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guestId = photos.hideSubmission(id);
  if (guestId === undefined) {
    return redirectWithMsg(res, '/admin/photos', 'Submission not found.');
  }
  redirectWithMsg(res, '/admin/photos', 'Photo taken down.');
});

// POST /admin/photos/:id/restore  — unhide a photo. photos.restoreSubmission
// flips the flag and recomputes the guest's auto-badges in one transaction —
// see the takedown route above.
router.post('/photos/:id/restore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guestId = photos.restoreSubmission(id);
  if (guestId === undefined) {
    return redirectWithMsg(res, '/admin/photos', 'Submission not found.');
  }
  redirectWithMsg(res, '/admin/photos', 'Photo restored.');
});

// ---------------------------------------------------------------------------
// GET /admin/export  — one-click export: streams a ZIP (per-guest photo folders)
// plus summary.xlsx. Defined per 09-export.md. Protected by requireAdmin
// (applied to this router above), so this route is too.
// ---------------------------------------------------------------------------
router.get('/export', async (req, res, next) => {
  try {
    await streamExportZip(res);
  } catch (err) {
    // If nothing has been sent yet, hand off to the Express error handler.
    if (!res.headersSent) {
      next(err);
    } else {
      console.error('[admin/export] failed mid-stream:', err);
      res.destroy(err);
    }
  }
});

module.exports = router;
