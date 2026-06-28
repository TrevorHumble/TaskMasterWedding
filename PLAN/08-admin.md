# 08 — Admin dashboard: guests, tasks, points, badges, takedown, QR sheet

This section builds the entire password-protected admin area. Everything here lives behind the `requireAdmin` middleware (built in section 03). When you finish, the Task Master will be able to: see a dashboard, create and bulk-create guests, print a QR place-card sheet, manage tasks, award bonus points, award/remove special badges, take photos down and restore them, and click through to the export.

## What you are building in this section

Files you will CREATE in this section:

- `src/routes/admin.js` — the admin router (all routes)
- `src/views/admin-dashboard.ejs`
- `src/views/admin-guests.ejs`
- `src/views/admin-qrsheet.ejs`
- `src/views/admin-tasks.ejs`
- `src/views/admin-photos.ejs`
- `src/public/js/admin.js`

Files from OTHER sections you must NOT rewrite (you only depend on them):

- `src/db.js` (section 02) — exports `db` (a better-sqlite3 database) and helpers
- `src/middleware/session.js` (section 03) — exports `requireAdmin`
- `src/services/qr.js` (section 03) — exports `qrDataUrl` (URL string -> PNG data-URI)
- `src/services/scoring.js` (section 06) — exports `addBonusPoints`, `awardSpecialBadge`, `removeSpecialBadge`, `recomputeAutoBadges`, leaderboard helpers, threshold constants
- `src/services/photos.js` (section 05) — exports photo helpers (including a hard-delete that removes the original + thumbnail files from disk)
- `src/services/export.js` (section 09) — the export
- `src/views/partials/head.ejs`, `header.ejs`, `footer.ejs` (section 10)
- `src/app.js` (section 01) — you will ADD one line to mount the router

> IMPORTANT: The routes `GET /admin/login`, `POST /admin/login`, and `POST /admin/logout` are owned by section 03 (auth). Do NOT define them here. This router defines everything else under `/admin`.

---

## Step 0 — Confirm the helper functions this section calls

Before writing code, open the named files and confirm these exported names exist. They are produced by other sections per the foundation contract. The names below are the exact names those sections export — match them precisely, because a misspelled call (e.g. `qr.toDataURL` instead of `qr.qrDataUrl`, or `scoring.recompute` instead of `scoring.recomputeAutoBadges`) throws `is not a function` at runtime and breaks the route.

1. Open `src/db.js`. Confirm it exports an object whose property `db` is the better-sqlite3 database. This section uses `const { db } = require('../db');`.
2. Open `src/middleware/session.js`. Confirm it exports `requireAdmin`. This section uses `const { requireAdmin } = require('../middleware/session');`.
3. Open `src/services/qr.js`. Confirm it exports an async function named **`qrDataUrl`** that turns a URL string into a PNG data-URI. This section uses `const qr = require('../services/qr');` and calls `await qr.qrDataUrl(url)`. (Section 03 exports `{ qrDataUrl }` — NOT `toDataURL`. If you copied an older draft that called `qr.toDataURL`, fix it to `qr.qrDataUrl` or the `/admin/qrsheet` route throws for every guest.)
4. Open `src/services/scoring.js`. Confirm it exports: `addBonusPoints(guestId, delta)`, `awardSpecialBadge(guestId, badgeCode)`, `removeSpecialBadge(guestId, badgeCode)`, **`recomputeAutoBadges(guestId)`** (NOT `recompute`), and a function that returns the leaderboard / per-guest totals. This section uses `pointsForGuest(guestId)` to read a guest's total points and `completedCount(guestId)` to read completed-task count. If those read-helpers are named differently, adjust the two call sites noted in `routes/admin.js` comments. (Worst case, the SQL fallbacks shown in comments compute the same numbers directly from the DB.)

   > NOTE ON BONUS POINTS: section 06's `addBonusPoints` is **clamped at 0** — it runs `bonus_points = MAX(0, bonus_points + delta)`. A deduction can never drive a guest's bonus below zero. Applying `-3` to a guest with `+3` bonus lands at `0`; applying a further `-5` still lands at `0`, not `-2`. This section's UI and acceptance checks reflect that clamped behavior.
5. Open `config.js`. Confirm it exports `BASE_URL` (UPPER_SNAKE_CASE). This section uses it to build the link printed in QR codes. If the config key is `baseUrl` or anything other than `BASE_URL`, the link renders as `undefined/j/<token>` and every QR code points nowhere — fix the casing in `config.js` so `config.BASE_URL` resolves before printing.
6. Open `src/services/photos.js`. Confirm it exports a hard-delete helper that removes a submission's original photo file AND its thumbnail file from disk. This section uses it in the guest-delete route so deleting a guest does not leave orphaned image files. The code below calls `photos.hardDelete(submissionId)`; if the export is named differently (e.g. `deleteFiles` / `deleteOriginalFile` + `deleteThumbFile`), adjust the single call site in `POST /admin/guests/:id/delete`.

You do not need to change any of those files (other than confirming/fixing the `config.BASE_URL` casing). You are only confirming the names so your `require` calls resolve.

---

## Step 1 — Create `src/public/js/admin.js`

This is tiny client-side JavaScript that adds confirmation dialogs to destructive buttons (delete guest, delete task, take down photo) and to the bulk-create form. It runs on every admin page that loads it via the footer partial. It uses only vanilla JS — no framework.

Create the file exactly as below.

```javascript
// src/public/js/admin.js
// Client-side helpers for the admin pages: confirmation dialogs on destructive
// actions. Loaded by the footer partial on admin views. Vanilla JS only.
(function () {
  'use strict';

  // Any form with data-confirm="message" asks the user to confirm before submit.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) {
      return;
    }
    var message = form.getAttribute('data-confirm');
    if (message) {
      var ok = window.confirm(message);
      if (!ok) {
        event.preventDefault();
      }
    }
  });

  // Reorder helper: the Tasks page has "up"/"down" buttons. Each button posts a
  // hidden form. Nothing extra is needed here, but we keep a no-op hook so the
  // file is the single place to extend admin behavior later.
})();
```

---

## Step 2 — Create the admin router `src/routes/admin.js`

This is the core of the section. Read the comments — they explain every block. The file is long because it is complete; copy it whole.

Key rules baked into this file:

- All routes use `requireAdmin` (applied once with `router.use`).
- The router also sets `res.locals.isAdmin = true` once (via `router.use`) so the shared header partial renders the ADMIN nav (Dashboard / Tasks / Guests / Photos / QR Sheet / Log out) instead of the guest nav. Without this, every admin page would show the guest navigation and no logout button.
- better-sqlite3 is synchronous: use `.prepare(sql).get(...)`, `.all(...)`, `.run(...)`. No `await` on the DB.
- POST handlers do their work, then redirect (303) to a GET page with a `?msg=` query so the user sees a confirmation. The views read `req.query.msg`.
- Tokens for new guests are 32 hex chars from `crypto.randomBytes(16).toString('hex')`.
- Scoring side effects (points, badges, takedowns) call into `src/services/scoring.js` so the math lives in one place. The auto-badge recompute function is named `recomputeAutoBadges` (section 06).

```javascript
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

// Total points for a guest. Prefer the scoring service; fall back to SQL so this
// page never crashes if the helper name differs. NOTE: bonus_points may be
// negative (scoring.addBonusPoints is additive, not clamped at 0), so this sum
// can be lower than the completed-task count.
function pointsForGuest(guestId) {
  if (typeof scoring.pointsForGuest === 'function') {
    return scoring.pointsForGuest(guestId);
  }
  const row = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM submissions
            WHERE guest_id = ? AND taken_down = 0) AS completed,
         (SELECT bonus_points FROM guests WHERE id = ?) AS bonus`
    )
    .get(guestId, guestId);
  return (row.completed || 0) + (row.bonus || 0);
}

// Completed (non-taken-down) task count for a guest.
function completedCount(guestId) {
  if (typeof scoring.completedCount === 'function') {
    return scoring.completedCount(guestId);
  }
  const row = db
    .prepare(
      'SELECT COUNT(*) AS n FROM submissions WHERE guest_id = ? AND taken_down = 0'
    )
    .get(guestId);
  return row.n || 0;
}

// ---------------------------------------------------------------------------
// GET /admin  — dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const counts = {
    guests: db.prepare('SELECT COUNT(*) AS n FROM guests').get().n,
    tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n,
    activeTasks: db
      .prepare('SELECT COUNT(*) AS n FROM tasks WHERE is_active = 1')
      .get().n,
    submissions: db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    livePhotos: db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 0')
      .get().n,
    takenDown: db
      .prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 1')
      .get().n,
    badgesAwarded: db
      .prepare('SELECT COUNT(*) AS n FROM guest_badges')
      .get().n,
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
  const guests = db
    .prepare('SELECT * FROM guests ORDER BY created_at ASC, id ASC')
    .all();

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
      points: pointsForGuest(g.id),
      completed: completedCount(g.id),
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
  const subs = db
    .prepare('SELECT id FROM submissions WHERE guest_id = ?')
    .all(id);
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
  const badge = db
    .prepare("SELECT * FROM badges WHERE code = ? AND type = 'special'")
    .get(code);
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
    const guests = db
      .prepare('SELECT * FROM guests ORDER BY name ASC, id ASC')
      .all();

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
  const tasks = db
    .prepare('SELECT * FROM tasks ORDER BY sort_order ASC, id ASC')
    .all();

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

// POST /admin/tasks/:id/delete  — delete a task (cascades its submissions).
router.post('/tasks/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
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
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(
      neighbor.sort_order,
      task.id
    );
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(
      task.sort_order,
      neighbor.id
    );
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

// POST /admin/photos/:id/takedown  — hide a photo, then recompute the guest's
// auto-badges (a hidden photo no longer counts toward points or auto-badges).
router.post('/photos/:id/takedown', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db
    .prepare('SELECT id, guest_id FROM submissions WHERE id = ?')
    .get(id);
  if (!sub) {
    return redirectWithMsg(res, '/admin/photos', 'Submission not found.');
  }
  db.prepare('UPDATE submissions SET taken_down = 1 WHERE id = ?').run(id);
  scoring.recomputeAutoBadges(sub.guest_id); // revokes auto-badges if count dropped
  redirectWithMsg(res, '/admin/photos', 'Photo taken down.');
});

// POST /admin/photos/:id/restore  — unhide a photo, then recompute auto-badges.
router.post('/photos/:id/restore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const sub = db
    .prepare('SELECT id, guest_id FROM submissions WHERE id = ?')
    .get(id);
  if (!sub) {
    return redirectWithMsg(res, '/admin/photos', 'Submission not found.');
  }
  db.prepare('UPDATE submissions SET taken_down = 0 WHERE id = ?').run(id);
  scoring.recomputeAutoBadges(sub.guest_id); // re-grants auto-badges if threshold met
  redirectWithMsg(res, '/admin/photos', 'Photo restored.');
});

// ---------------------------------------------------------------------------
// GET /admin/export  — defined in 09-export.md. See the "ADD THIS to
// src/routes/admin.js" snippet in that section; paste it here, just above
// `module.exports = router;`. Do not invent it now.
// ---------------------------------------------------------------------------

module.exports = router;
```

---

## Step 3 — Mount the router in `src/app.js`

> ONE mounting mechanism only. The original `src/app.js` (section 01) shipped with an auto-mounter (`mountRouterIfPresent`) that did `app.use('/', router)` for every router file it found. That is incompatible with this admin router, which MUST be mounted at `/admin` (not `/`). If the auto-mounter mounts `admin.js` at `/`, the dashboard route `router.get('/')` collides with the guest home and `/admin/guests` becomes `/guests` — the whole admin area is unreachable at its documented URLs, and `requireAdmin` ends up gating the guest home. The auto-mounter also risks mounting auth/guest/community routers twice (once by the auto-mounter, once by each section's explicit `app.use`), so every route would run twice.

**The plan-wide decision: keep section 01's auto-mounter — do NOT mount routers by hand.** Section 01's `app.js` already auto-detects `src/routes/admin.js` and mounts it at `/admin` (and auth/guest/community at `/`) the moment the file exists. There is nothing to change in `app.js` for this section.

1. Do **not** delete the `mountRouterIfPresent` block in `src/app.js`.
2. Do **not** add an explicit `app.use('/admin', ...)` line — that would mount the admin router twice, so every admin handler would run twice.

**NO CHANGE to `src/app.js` is needed.** Once `src/routes/admin.js` exists, restart the server (`npm start`) and the auto-mounter picks it up at `/admin` automatically. (This supersedes any earlier draft that told you to remove the auto-mounter and add explicit mount lines — sections 04 and 07 carry the same correction.)

Notes:
- The admin router defines its paths relative to `/admin` (e.g. `router.get('/guests', ...)` becomes `GET /admin/guests`), EXCEPT the dashboard which is `router.get('/')` -> `GET /admin`.
- Section 03's auth router defines `/admin/login` and `/admin/logout` using full paths and is mounted at `/`. Section 01's auto-mounter already mounts auth and admin **before** the guest router (its fixed order is auth → admin → guest → community), so `/admin/login` is matched by the public auth route first, the admin pages are reached before the guest gate, and the admin router's `requireAdmin` never blocks the login page. You do not need to do anything to enforce this ordering.
- `express.urlencoded` is added globally in `app.js` (section 01), so all the `application/x-www-form-urlencoded` POST forms on these admin pages parse correctly. Do not add a second body parser here.

---

## Step 4 — Create `src/views/admin-dashboard.ejs`

This view shows headline counts and big links to the other admin pages and to the export. It uses the shared partials. The partials open `<head>`/`<body>` and load `theme.css`; the footer loads the page script if you pass one — here we do not need a page script on the dashboard, but admin pages that have confirm buttons load `/js/admin.js` by adding a `<script>` tag of their own just before the footer include (shown in later views).

```html
<!-- src/views/admin-dashboard.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="container admin">
  <h1 class="display">Admin Dashboard</h1>

  <% if (msg) { %>
    <p class="flash"><%= msg %></p>
  <% } %>

  <section class="card-grid">
    <div class="stat-card">
      <span class="stat-number"><%= counts.guests %></span>
      <span class="stat-label">Guests</span>
    </div>
    <div class="stat-card">
      <span class="stat-number"><%= counts.activeTasks %></span>
      <span class="stat-label">Active tasks (<%= counts.tasks %> total)</span>
    </div>
    <div class="stat-card">
      <span class="stat-number"><%= counts.livePhotos %></span>
      <span class="stat-label">Live photos</span>
    </div>
    <div class="stat-card">
      <span class="stat-number"><%= counts.takenDown %></span>
      <span class="stat-label">Taken down</span>
    </div>
    <div class="stat-card">
      <span class="stat-number"><%= counts.badgesAwarded %></span>
      <span class="stat-label">Badges held</span>
    </div>
  </section>

  <nav class="admin-links">
    <a class="btn btn-primary" href="/admin/guests">Manage guests</a>
    <a class="btn" href="/admin/qrsheet">Print QR place-cards</a>
    <a class="btn" href="/admin/tasks">Manage tasks</a>
    <a class="btn" href="/admin/photos">Photos &amp; takedowns</a>
    <a class="btn btn-primary" href="/admin/export">Download export (ZIP + spreadsheet)</a>
  </nav>

  <p class="muted">
    Tip: the public pages are
    <a href="/leaderboard">/leaderboard</a> and
    <a href="/gallery">/gallery</a>.
  </p>
</main>

<%- include('partials/footer') %>
```

---

## Step 5 — Create `src/views/admin-guests.ejs`

This is the busiest page: a guest table with each guest's private link, points, completed count, and held special badges, plus inline forms to rename, delete, award points, and award/remove a special badge. Above the table are the "add one guest" and "bulk create N guests" forms. It loads `/js/admin.js` for the confirm dialogs.

The badge controls: for each guest and each special badge, show either an "Award" button (if the guest does not hold it) or a "Remove" button (if they do). This keeps it one click.

```html
<!-- src/views/admin-guests.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="container admin">
  <h1 class="display">Guests</h1>

  <% if (msg) { %>
    <p class="flash"><%= msg %></p>
  <% } %>

  <p>
    <a class="btn" href="/admin">&larr; Dashboard</a>
    <a class="btn" href="/admin/qrsheet">Print QR place-cards</a>
  </p>

  <section class="form-row">
    <form action="/admin/guests" method="post" class="inline-form">
      <h2>Add one guest</h2>
      <label>
        Name (optional)
        <input type="text" name="name" placeholder="e.g. Aunt Marigold" />
      </label>
      <button type="submit" class="btn btn-primary">Add guest</button>
    </form>

    <form action="/admin/guests/bulk" method="post" class="inline-form"
          data-confirm="Create this many new blank guests?">
      <h2>Bulk create</h2>
      <label>
        How many?
        <input type="number" name="count" min="1" max="500" value="10" />
      </label>
      <button type="submit" class="btn btn-primary">Create blanks</button>
    </form>
  </section>

  <p class="muted">
    Each guest has a private sign-in link. Give it to them by printing the QR
    sheet, or copy a link below.
  </p>

  <table class="admin-table">
    <thead>
      <tr>
        <th>#</th>
        <th>Name</th>
        <th>Points</th>
        <th>Done</th>
        <th>Private link</th>
        <th>Bonus points</th>
        <th>Special badges</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <% guests.forEach(function (g) { %>
        <tr>
          <td><%= g.id %></td>
          <td>
            <form action="/admin/guests/<%= g.id %>/edit" method="post" class="cell-form">
              <input type="text" name="name" value="<%= g.name %>" placeholder="(no name)" />
              <button type="submit" class="btn btn-small">Save</button>
            </form>
          </td>
          <td><%= g.points %></td>
          <td><%= g.completed %></td>
          <td class="link-cell">
            <input type="text" readonly value="<%= g.link %>"
                   onclick="this.select();" />
          </td>
          <td>
            <form action="/admin/guests/<%= g.id %>/points" method="post" class="cell-form">
              <input type="number" name="delta" value="1" />
              <button type="submit" class="btn btn-small">Apply</button>
            </form>
            <span class="muted">cur: <%= g.bonus_points %></span>
          </td>
          <td class="badge-cell">
            <% specialBadges.forEach(function (b) { %>
              <% var held = g.heldCodes.indexOf(b.code) !== -1; %>
              <form action="/admin/guests/<%= g.id %>/badge" method="post" class="badge-form">
                <input type="hidden" name="code" value="<%= b.code %>" />
                <input type="hidden" name="action" value="<%= held ? 'remove' : 'award' %>" />
                <button type="submit"
                        class="btn btn-small <%= held ? 'btn-on' : '' %>"
                        title="<%= b.name %>">
                  <%= held ? '★ ' : '+ ' %><%= b.name %>
                </button>
              </form>
            <% }); %>
          </td>
          <td>
            <form action="/admin/guests/<%= g.id %>/delete" method="post"
                  data-confirm="Delete <%= g.name || ('guest #' + g.id) %> and PERMANENTLY remove all their photos (files deleted from disk) and badges? This cannot be undone.">
              <button type="submit" class="btn btn-small btn-danger">Delete</button>
            </form>
          </td>
        </tr>
      <% }); %>
      <% if (guests.length === 0) { %>
        <tr><td colspan="8" class="muted">No guests yet. Add one above.</td></tr>
      <% } %>
    </tbody>
  </table>
</main>

<script src="/js/admin.js" defer></script>
<%- include('partials/footer') %>
```

---

## Step 6 — Create `src/views/admin-qrsheet.ejs`

A print-friendly grid: one card per guest with their name and a QR image. The QR images are already rendered to PNG data-URIs by the router, so they print without any network call. The page has print CSS so that, when the Task Master presses Ctrl+P, only the cards print (header/buttons hidden) and the grid lays out cleanly on paper.

This view DOES include `partials/header` (which opens `<main class="page">`) so that `partials/footer` (which closes `</main>`) is balanced — otherwise the footer emits an orphan `</main>` and the HTML is malformed. The on-screen header/nav is hidden in the `@media print` block so the printed sheet shows only the cards.

It also shows a loud warning when `BASE_URL` is still `http://localhost…`, because QR codes built from a localhost URL are unscannable from guests' phones. The operator must set `BASE_URL` to the tunnel (trycloudflare.com) URL and restart the server before printing.

```html
<!-- src/views/admin-qrsheet.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<style>
  /* On-screen styling */
  .qrsheet-toolbar { margin: 1rem; }
  .qr-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.5rem;
    margin: 1rem;
  }
  .qr-card {
    border: 1px dashed #c9b8d6;
    border-radius: 12px;
    padding: 0.75rem;
    text-align: center;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .qr-card img { width: 160px; height: 160px; }
  .qr-card .qr-name {
    font-family: var(--font-display, cursive);
    font-size: 1.3rem;
    margin: 0.3rem 0;
  }
  .qr-card .qr-hint { font-size: 0.7rem; color: #777; word-break: break-all; }

  /* Print styling: hide everything but the cards, fit 3 across on the page. */
  @media print {
    .qrsheet-toolbar, header, footer,
    .site-header, .site-footer, .page-nav, nav { display: none !important; }
    body { background: #fff !important; }
    .qr-grid { gap: 0.25rem; margin: 0; }
    .qr-card { border: 1px dashed #aaa; }
    @page { margin: 1cm; }
  }
</style>

<% if (baseUrl.indexOf('localhost') !== -1) { %>
  <p class="flash flash-err">
    Warning: BASE_URL is localhost. Set BASE_URL to your trycloudflare.com URL
    and restart before printing, or these QR codes will not work on guests'
    phones.
  </p>
<% } %>

<div class="qrsheet-toolbar">
  <a class="btn" href="/admin">&larr; Dashboard</a>
  <button type="button" class="btn btn-primary" onclick="window.print();">Print this sheet</button>
  <span class="muted">Base URL for links: <%= baseUrl %></span>
</div>

<div class="qr-grid">
  <% cards.forEach(function (c) { %>
    <div class="qr-card">
      <img src="<%= c.qr %>" alt="QR code for <%= c.name %>" />
      <p class="qr-name"><%= c.name %></p>
      <p class="qr-hint">Scan to sign in</p>
    </div>
  <% }); %>
  <% if (cards.length === 0) { %>
    <p class="muted">No guests yet. Create guests first on the Guests page.</p>
  <% } %>
</div>

<%- include('partials/footer') %>
```

> Note: the `@media print` block hides the header/nav and toolbar so only the cards print, while keeping the `<main>`/`</main>` tags balanced on screen and in the markup. The print preview should show just the QR cards, three across.

---

## Step 7 — Create `src/views/admin-tasks.ejs`

A table of tasks with inline edit (title + description), an active/hidden toggle, up/down reorder buttons, and delete. Above it, the "add a task" form. Loads `/js/admin.js` for the delete confirm.

```html
<!-- src/views/admin-tasks.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="container admin">
  <h1 class="display">Tasks</h1>

  <% if (msg) { %>
    <p class="flash"><%= msg %></p>
  <% } %>

  <p><a class="btn" href="/admin">&larr; Dashboard</a></p>

  <form action="/admin/tasks" method="post" class="stacked-form">
    <h2>Add a task</h2>
    <label>
      Title
      <input type="text" name="title" required placeholder="e.g. Photo with the couple" />
    </label>
    <label>
      Description (optional)
      <textarea name="description" rows="2" placeholder="What should the guest photograph?"></textarea>
    </label>
    <button type="submit" class="btn btn-primary">Add task</button>
  </form>

  <table class="admin-table">
    <thead>
      <tr>
        <th>Order</th>
        <th>Title &amp; description</th>
        <th>Photos</th>
        <th>Visible?</th>
        <th>Move</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody>
      <% tasks.forEach(function (t) { %>
        <tr class="<%= t.is_active ? '' : 'row-inactive' %>">
          <td><%= t.sort_order %></td>
          <td>
            <form action="/admin/tasks/<%= t.id %>/edit" method="post" class="cell-form-stacked">
              <input type="text" name="title" value="<%= t.title %>" required />
              <textarea name="description" rows="2"><%= t.description %></textarea>
              <button type="submit" class="btn btn-small">Save</button>
            </form>
          </td>
          <td><%= t.submissions %></td>
          <td>
            <form action="/admin/tasks/<%= t.id %>/active" method="post">
              <button type="submit" class="btn btn-small">
                <%= t.is_active ? 'Active (hide)' : 'Hidden (show)' %>
              </button>
            </form>
          </td>
          <td class="move-cell">
            <form action="/admin/tasks/reorder" method="post">
              <input type="hidden" name="id" value="<%= t.id %>" />
              <input type="hidden" name="direction" value="up" />
              <button type="submit" class="btn btn-small" <%= t.isFirst ? 'disabled' : '' %>>▲</button>
            </form>
            <form action="/admin/tasks/reorder" method="post">
              <input type="hidden" name="id" value="<%= t.id %>" />
              <input type="hidden" name="direction" value="down" />
              <button type="submit" class="btn btn-small" <%= t.isLast ? 'disabled' : '' %>>▼</button>
            </form>
          </td>
          <td>
            <form action="/admin/tasks/<%= t.id %>/delete" method="post"
                  data-confirm="Delete the task &quot;<%= t.title %>&quot; and ALL its photo submissions? This cannot be undone.">
              <button type="submit" class="btn btn-small btn-danger">Delete</button>
            </form>
          </td>
        </tr>
      <% }); %>
      <% if (tasks.length === 0) { %>
        <tr><td colspan="6" class="muted">No tasks yet. Add one above.</td></tr>
      <% } %>
    </tbody>
  </table>
</main>

<script src="/js/admin.js" defer></script>
<%- include('partials/footer') %>
```

---

## Step 8 — Create `src/views/admin-photos.ejs`

Lists every submission (including taken-down ones), shows the thumbnail, who submitted it and for which task, and a single button to take it down or restore it. Loads `/js/admin.js` so the takedown can confirm.

Thumbnails are served from `/thumbs/<thumb_path>` per the photo-serving convention (`app.use('/thumbs', express.static(THUMBS_DIR))`). The `thumb_path` column stores the relative filename.

```html
<!-- src/views/admin-photos.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="container admin">
  <h1 class="display">Photos &amp; takedowns</h1>

  <% if (msg) { %>
    <p class="flash"><%= msg %></p>
  <% } %>

  <p><a class="btn" href="/admin">&larr; Dashboard</a></p>

  <p class="muted">
    Taken-down photos are hidden from the gallery, profiles, and scoring, but
    the files stay on disk so they are still included in the export. (Deleting a
    GUEST, by contrast, permanently removes that guest's photo files from disk.)
  </p>

  <div class="photo-admin-grid">
    <% photos.forEach(function (p) { %>
      <div class="photo-admin-card <%= p.taken_down ? 'is-down' : '' %>">
        <img src="/thumbs/<%= p.thumb_path %>"
             alt="Photo by <%= p.guest_name || ('guest #' + p.guest_id) %> for <%= p.task_title %>"
             loading="lazy" />
        <p class="photo-meta">
          <strong><%= p.guest_name || ('Guest #' + p.guest_id) %></strong><br />
          <span class="muted"><%= p.task_title %></span>
        </p>
        <% if (p.caption) { %>
          <p class="photo-caption"><%= p.caption %></p>
        <% } %>
        <% if (p.taken_down) { %>
          <p class="status-down">TAKEN DOWN</p>
          <form action="/admin/photos/<%= p.id %>/restore" method="post">
            <button type="submit" class="btn btn-small">Restore</button>
          </form>
        <% } else { %>
          <form action="/admin/photos/<%= p.id %>/takedown" method="post"
                data-confirm="Take down this photo? It will be hidden from the gallery, profiles, and scoring.">
            <button type="submit" class="btn btn-small btn-danger">Take down</button>
          </form>
        <% } %>
      </div>
    <% }); %>
    <% if (photos.length === 0) { %>
      <p class="muted">No photos submitted yet.</p>
    <% } %>
  </div>
</main>

<script src="/js/admin.js" defer></script>
<%- include('partials/footer') %>
```

---

## Step 9 — A note on view variables and the partials

Each view above calls `include('partials/head')`, `include('partials/header')`, `include('partials/footer')` (section 10 owns those). Per the foundation contract:

- `res.locals.guest` and `res.locals.flash` are available to ALL views automatically (set by middleware). On admin pages there is no guest, so `res.locals.guest` will be undefined/null — the partials must tolerate that. They are written in section 10 to do so. You do not need to pass `guest` from admin routes.
- `res.locals.isAdmin` is set to `true` by the `router.use` block at the top of `routes/admin.js`, AND every admin `res.render` also passes `isAdmin: true` explicitly. `partials/header.ejs` reads `isAdmin` to choose the ADMIN nav (Dashboard / Tasks / Guests / Photos / QR Sheet / Log out) over the GUEST nav. If you skip this, admin pages render the guest nav with no logout button.
- Every admin route here passes a `title` and (where relevant) a `msg`. The `head` partial uses `title` for the `<title>` tag (it should default to a fallback if absent; section 10 handles that). If, when you test, you get `title is not defined` errors, it means the `head` partial references `title` without a default — that is a section 10 concern; as a stopgap you have already passed `title` from every route here, so it will be defined.

No changes to the partials are needed from this section.

---

## Acceptance check

Do these steps in order. Expected results are stated; if you see something different, the section is not done.

1. Make sure prerequisites from earlier sections are in place. From the project root in PowerShell:

   ```powershell
   npm install
   node scripts/set-admin-password.js ButtMonster
   node scripts/seed.js
   npm start
   ```

   Expected: the server prints that it is listening on `http://localhost:3000` with no stack trace. (If `scripts/seed.js` or `db.js` do not exist yet because section 02 is not built, you cannot fully test — but `src/routes/admin.js` must still load without a syntax error. To check syntax only, run `node -e "require('./src/routes/admin.js')"` from the project root; expect either silence/success or an error that is about a MISSING dependency module, not a syntax error in this file.)

2. In a browser, go to `http://localhost:3000/admin`. Because you are not logged in, expect to be redirected to `http://localhost:3000/admin/login` (the login page from section 03). (If `/admin` returns the GUEST home page or 404s instead of redirecting to login, the admin router did not mount — confirm `src/routes/admin.js` exists and that section 01's `app.js` still has the `mountRouterIfPresent('admin.js')` line, then restart the server.)

3. Log in with password `ButtMonster`. Expect to land back on a page; navigate to `http://localhost:3000/admin`. Expected: the dashboard renders with stat cards (Guests, Active tasks, Live photos, Taken down, Badges held), the ADMIN nav (Dashboard / Tasks / Guests / Photos / QR Sheet / Log out) is shown at the top — NOT the guest nav — and there is a row of buttons including "Download export".

4. Click "Manage guests" (`/admin/guests`). In "Bulk create", enter `5` and submit; confirm the dialog. Expected: page reloads, a green-ish flash says "Created 5 guest(s).", and the table now has 5 rows, each with a unique `http://localhost:3000/j/<token>` link. (If links read `undefined/j/<token>`, fix the `config.BASE_URL` casing per Step 0.)

5. In one guest's row, type a name and click Save. Expected: flash "Guest updated." and the name persists after reload.

6. In a guest's "Bonus points" cell, enter `3` and click Apply. Expected: flash "Awarded 3 bonus point(s)." and that guest's Points column increases by 3, with `cur: 3` shown. Enter `-3` and Apply; Points drops back and `cur: 0` is shown. NOTE: bonus points are clamped at 0 — if you then apply `-2`, `cur:` stays at `0` (never negative) and Points does not drop below the guest's completed-task count. That is expected behavior, not a bug.

7. In a guest's "Special badges" cell, click one badge button (e.g. "+ Early Bird"). Expected: flash "Awarded badge ...", the same button now shows a star and reads "★ Early Bird". Click it again. Expected: flash "Removed badge ..." and it returns to "+ Early Bird".

8. Go to `/admin/qrsheet`. Expected: a grid of cards, one per guest, each with a scannable QR image and the guest's name (or "Guest #N" if unnamed). If `BASE_URL` is still localhost, a red warning banner appears telling you to set the tunnel URL before printing. Press "Print this sheet" (or Ctrl+P) and check the print preview: only the cards show, three across, with the toolbar/header/nav hidden.

9. Scan one QR with a phone (or open its `/j/<token>` link in a private browser window). Expected: it opens the guest onboarding/sign-in flow from section 03 (proves the link in the QR is correct). For a real day-of test the QR must encode the tunnel URL, not localhost.

10. Go to `/admin/tasks`. Add a task with a title. Expected: flash "Task added." and it appears at the bottom of the table. Use the ▲/▼ buttons to move it; expect its Order number to swap with the neighbor and the row order to change on reload. Click the visibility toggle; expect the label to flip between "Active (hide)" and "Hidden (show)" and the row to dim when hidden. Click Delete and confirm; expect the task to disappear.

11. Have a guest submit a photo for a task (section 04/05 flow), then go to `/admin/photos`. Expected: the photo's thumbnail appears with the guest name and task title. Click "Take down" and confirm. Expected: flash "Photo taken down.", the card shows "TAKEN DOWN", and that guest's Points on `/admin/guests` drops by 1 (and any auto-badge they no longer qualify for is removed by `scoring.recomputeAutoBadges`). Click "Restore"; expect the point and badge to come back.

12. Delete a guest who has at least one photo: on `/admin/guests` click Delete and confirm. Expected: flash "Guest and their photos deleted.", the row disappears, and the guest's original photo files AND thumbnails are gone from disk (check `data/uploads`). This is intentional and irreversible — a deleted guest's photos are NOT recoverable from the export.

13. Confirm the export link works end-to-end only AFTER section 09 is built: click "Download export" on the dashboard. Expected (post-09): a ZIP downloads. Until 09 is built, this link will 404 — that is expected and not a fault of this section.

If steps 2–12 all behave as described, this section is complete.
