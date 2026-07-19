// src/routes/admin.js
// Admin router. Every route here is behind requireAdmin (applied below).
// Routes:
//   GET  /admin                          dashboard
//   GET  /admin/guests                   guests table
//   POST /admin/guests/:id/edit          rename a guest / set gallery pin
//   POST /admin/guests/:id/delete        delete a guest (cascades submissions/badges; deletes photo files)
//   POST /admin/guests/:id/points        award bonus points (scoring.addBonusPoints)
//   POST /admin/guests/:id/badge         award OR remove a special badge
//   GET  /admin/poster                   the single shared entry-link poster (issue #244)
//   GET  /admin/tasks                    task list + add form
//   POST /admin/tasks                    create a task
//   POST /admin/tasks/:id/edit           edit a task title/description
//   POST /admin/tasks/:id/badge          set a task's badge name/art
//   POST /admin/tasks/:id/delete         delete a task (cascades submissions)
//   POST /admin/tasks/:id/active         toggle is_active
//   POST /admin/tasks/reorder            move a task up/down (sort_order)
//   GET  /admin/photos                   ALL submissions incl. taken-down
//   POST /admin/photos/:id/takedown      hide a photo + recompute auto-badges
//   POST /admin/photos/:id/restore       unhide a photo + recompute auto-badges
//   POST /admin/photos/:id/points        set a photo's bonus points (absolute set)
//   GET  /admin/comments                 ALL comments incl. taken-down
//   POST /admin/comments/:id/hide        hide a comment
//   POST /admin/comments/:id/restore     unhide a comment
//   GET  /admin/bugs                     bug report queue (unresolved, then resolved)
//   POST /admin/bugs/:id/resolve         mark a bug report resolved
//   GET  /admin/export                   defined in 09-export (see ADD-THIS there)
//
// NOTE: GET/POST /admin/login and POST /admin/logout live in 03-auth (routes/auth.js).
//       Do NOT define them here.

const express = require('express');

const config = require('../../config');
const { db, getGuestByContact } = require('../db');
const { requireAdmin } = require('../middleware/session');
const qr = require('../services/qr');
const scoring = require('../services/scoring');
const photos = require('../services/photos');
const taskBadges = require('../services/task-badges');
const feed = require('../services/feed');
const { streamExportZip } = require('../services/export');
const { normalizeContact, isValidPin } = require('../services/identity');
const { relativeTime } = require('../services/relative-time');

const router = express.Router();

// Guard the whole router. Section 03's requireAdmin redirects to /admin/login
// when the signed admin cookie is not "1".
router.use(requireAdmin);

// Mark every admin page as an admin context so partials/header.ejs renders the
// ADMIN nav (Dashboard/Tasks/Guests/Photos/Poster/Log out) and the logout
// button, instead of the GUEST nav. Set once here so no individual res.render
// has to remember to pass isAdmin.
router.use((req, res, next) => {
  res.locals.isAdmin = true;
  next();
});

// ---------------------------------------------------------------------------
// Small local helpers
// ---------------------------------------------------------------------------

// Build a redirect target with a human message in the ?msg= query. An
// optional anchor lands the admin back at the element they acted on
// (fragment goes after the query, per URL syntax).
function redirectWithMsg(res, path, msg, anchor) {
  const sep = path.indexOf('?') === -1 ? '?' : '&';
  const hash = anchor ? '#' + anchor : '';
  res.redirect(303, path + sep + 'msg=' + encodeURIComponent(msg) + hash);
}

// ---------------------------------------------------------------------------
// Retired routes (issue #244 AC2/AC3): guest-creation (POST /guests, POST
// /guests/bulk) and the per-guest QR sheet (GET /qrsheet) must respond 404,
// not just fall out of this router unhandled. That distinction matters here:
// app.js mounts guest.js (at '/') right after this router, and guest.js runs
// `router.use(requireGuest)` unconditionally for every path it sees — so a
// path this router doesn't recognize does NOT reach app.js's real 404
// handler, it falls through into guest.js and comes back as a 302 to /join
// instead (requireGuest has no guest session to check for an admin-only
// visitor). Rendering the same 404 view these three retired paths used to
// return before they existed is not needed for anything else on this
// router — every path a guest can legitimately reach here still has its own
// route above/below and never reaches this block.
// ---------------------------------------------------------------------------
function renderNotFound(req, res) {
  res.status(404).render('404', { url: req.originalUrl });
}
router.post('/guests', renderNotFound);
router.post('/guests/bulk', renderNotFound);
router.get('/qrsheet', renderNotFound);

// ---------------------------------------------------------------------------
// GET /admin  — dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  const counts = {
    guests: db.prepare('SELECT COUNT(*) AS n FROM guests').get().n,
    activeTasks: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE is_active = 1').get().n,
    submissions: db.prepare('SELECT COUNT(*) AS n FROM submissions').get().n,
    livePhotos: db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 0').get().n,
    takenDown: db.prepare('SELECT COUNT(*) AS n FROM submissions WHERE taken_down = 1').get().n,
    badgesAwarded: db.prepare('SELECT COUNT(*) AS n FROM guest_badges').get().n,
  };

  // Sixth stat cell (issue #256 / #245): unresolved bug-report count.
  const openBugs = db.prepare('SELECT COUNT(*) AS n FROM bug_reports WHERE resolved = 0').get().n;

  // Pulse line (issue #256): the newest VISIBLE submission. feed.js owns the
  // visibility predicate and newest-first ordering (its VISIBLE_WHERE /
  // ORDER_NEWEST_FIRST single owners), so this route consumes
  // feed.newestVisibleSubmission() rather than re-typing the SQL — the pulse
  // then agrees with the gallery on "which is newest" and never surfaces a
  // photo the admin just took down.
  const newestVisible = feed.newestVisibleSubmission();
  const lastPhoto = newestVisible
    ? { rel: relativeTime(newestVisible.created_at), name: newestVisible.name || '' }
    : null;

  res.render('admin-dashboard', {
    title: 'Admin Dashboard',
    counts,
    openBugs,
    lastPhoto,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// ---------------------------------------------------------------------------
// GET /admin/guests  — table of guests
// ---------------------------------------------------------------------------
router.get('/guests', (req, res) => {
  const guests = db.prepare('SELECT * FROM guests ORDER BY created_at ASC, id ASC').all();

  // List of admin-awardable badges (special + custom, issue #80 AC5) so the
  // per-guest award control can offer them. 'metric'/'transferable' are
  // system-owned and never appear here.
  const specialBadges = db
    .prepare("SELECT * FROM badges WHERE type IN ('special', 'custom') ORDER BY type ASC, name ASC")
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
      bonus_points: g.bonus_points,
      pinned: g.pinned,
      points: scoring.getPoints(g.id),
      completed: scoring.getCompletedCount(g.id),
      heldCodes: held,
      // contact/pin (issue #243) so the admin can view and edit a guest's
      // re-entry identity — recovery on the spot at the reception, no reset
      // flow. '' rather than null so the EJS text-input `value=` never
      // renders the literal string "null".
      contact: g.contact || '',
      pin: g.pin || '',
    };
  });

  // Denominator for each card's "done/total tasks" meta line. ALL tasks, not
  // just active ones: the completed numerator (scoring.getCompletedCount)
  // counts visible submissions on hidden tasks too, and UNIQUE(guest_id,
  // task_id) + ON DELETE CASCADE bound it by the number of existing tasks —
  // so this denominator can never show "4/3 tasks". (Guest home clamps a
  // percentage instead; here the raw pair is displayed, so the denominator
  // must dominate.)
  const totalTasks = db.prepare('SELECT COUNT(*) AS n FROM tasks').get().n;

  res.render('admin-guests', {
    title: 'Guests',
    guests: rows,
    specialBadges,
    totalTasks,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/guests/:id/edit  — rename a guest and set their gallery pin.
// The pin (guests.pinned, issue #251) hoists this guest's section to the top
// of the gallery's By-person view — meant for the couple's own rows. An
// unchecked checkbox posts no `pinned` field at all, which is exactly the
// "unpin" signal.
router.post('/guests/:id/edit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const name = (req.body.name || '').trim();
  const pinned = req.body.pinned ? 1 : 0;
  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  db.prepare('UPDATE guests SET name = ?, pinned = ? WHERE id = ?').run(name, pinned, id);
  redirectWithMsg(res, '/admin/guests', 'Guest updated.');
});

// POST /admin/guests/:id/identity  — admin sets a guest's contact and/or
// re-entry PIN (issue #243). Goal C: the host can read a locked-out guest's
// PIN back to them on the spot, or fix a mistyped contact, with no reset
// flow. Both fields are optional and independent — an empty/absent field
// means "leave this one alone" (a host correcting only the PIN should not be
// forced to retype a correct contact, and vice versa).
//
// Validation is the SAME rule signup uses (normalizeContact / isValidPin
// from services/identity.js) — this route does not re-encode either rule,
// it calls the single owner both places already share.
router.post('/guests/:id/identity', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guest = db.prepare('SELECT id, contact, pin FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }

  const rawPin = typeof req.body.pin === 'string' ? req.body.pin.trim() : '';
  const rawContact = typeof req.body.contact === 'string' ? req.body.contact.trim() : '';

  // Validate PIN first (matches the plan's ordering) so a bad PIN never lets
  // a valid contact half-apply — either everything submitted is valid, or
  // nothing is written.
  if (rawPin) {
    if (!isValidPin(rawPin)) {
      return redirectWithMsg(res, '/admin/guests', 'Please choose a 4-digit PIN (numbers only).');
    }
  }

  let normalized = null;
  if (rawContact) {
    normalized = normalizeContact(rawContact);
    if (!normalized) {
      return redirectWithMsg(res, '/admin/guests', 'Please enter a valid email or phone number.');
    }
    // Collision check: one guest per normalized contact. Only a DIFFERENT
    // guest already holding this contact is a conflict — re-submitting the
    // guest's own current contact (unchanged, or just re-cased/reformatted)
    // must be allowed.
    const existing = getGuestByContact(normalized.value);
    if (existing && existing.id !== id) {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'That contact is already in use by another guest.'
      );
    }
  }

  if (!rawPin && !normalized) {
    // Neither field submitted (or both blank) — nothing to change.
    return redirectWithMsg(res, '/admin/guests', 'Nothing to update.');
  }

  // The collision check above is a pre-check, not a lock — a concurrent
  // request could still slip a colliding contact past it and into the
  // idx_guests_contact UNIQUE index before this UPDATE runs. Guard the write
  // itself the same way POST /admin/badges guards createCustomBadge's insert
  // above: catch the constraint violation and answer with the same friendly
  // "already in use" wording as the pre-check, instead of a bare 500.
  try {
    if (rawPin && normalized) {
      db.prepare('UPDATE guests SET pin = ?, contact = ?, contact_type = ? WHERE id = ?').run(
        rawPin,
        normalized.value,
        normalized.type,
        id
      );
    } else if (rawPin) {
      db.prepare('UPDATE guests SET pin = ? WHERE id = ?').run(rawPin, id);
    } else {
      db.prepare('UPDATE guests SET contact = ?, contact_type = ? WHERE id = ?').run(
        normalized.value,
        normalized.type,
        id
      );
    }
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'That contact is already in use by another guest.'
      );
    }
    throw err;
  }

  redirectWithMsg(res, '/admin/guests', 'Guest contact/PIN updated.');
});

// POST /admin/guests/:id/delete  — delete a guest. The FK cascade removes their
// submission rows and badge rows, but it does NOT touch the image files on disk.
// To keep disk and DB in sync (and avoid orphaned originals + thumbs that no
// export will ever pick up), we hard-delete each of the guest's photo files AND
// their avatar file (issue #196 — the avatar was the one file class this pass
// missed, leaving a deleted guest's portrait still fetchable at /uploads/<file>)
// BEFORE deleting the guest. This is irreversible — the confirm dialog in the
// view warns the operator.
router.post('/guests/:id/delete', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const guest = db.prepare('SELECT id, avatar_path FROM guests WHERE id = ?').get(id);
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

  // Remove the guest's avatar file, if any. deleteOriginalFile no-ops on a
  // null/empty path and already ignores ENOENT (a file already gone from disk
  // does not abort the delete — same policy as the submission files above).
  try {
    photos.deleteOriginalFile(guest.avatar_path);
  } catch (err) {
    console.error('Failed to delete avatar for guest', id, err);
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
  // It IS floor-clamped at 0: the UPDATE's MAX(0, ...) (scoring.js's
  // stmtAddBonus) means a large negative delta can never drive a guest's
  // bonus below zero. The admin sees the running total in the UI.
  scoring.addBonusPoints(id, delta);
  redirectWithMsg(
    res,
    '/admin/guests',
    (delta > 0 ? 'Awarded ' : 'Removed ') + Math.abs(delta) + ' bonus point(s).'
  );
});

// POST /admin/guests/:id/badge  — award OR remove a special OR custom badge.
// Body: code = badge code (EARLYBIRD/SHUTTERBUG/CROWDFAV/CHOICE, or any
//       admin-created custom code), action = "award", "remove", or "toggle"
//       ("toggle" resolves against the guest's current held state server-side,
//       so the badge-select form stays correct with JavaScript disabled).
// 'metric'/'transferable' codes are refused (issue #80 AC5) — those types are
// system-owned by scoring.recomputeBadges/recomputeTransferableBadges, and an
// admin award/remove attempt on one must not create or delete a guest_badges
// row.
router.post('/guests/:id/badge', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const code = (req.body.code || '').trim().toUpperCase();
  const action = (req.body.action || 'award').trim();

  const guest = db.prepare('SELECT id FROM guests WHERE id = ?').get(id);
  if (!guest) {
    return redirectWithMsg(res, '/admin/guests', 'Guest not found.');
  }
  const badge = db
    .prepare("SELECT * FROM badges WHERE code = ? AND type IN ('special', 'custom')")
    .get(code);
  if (!badge) {
    return redirectWithMsg(res, '/admin/guests', 'Unknown special or custom badge.');
  }

  let effective = action;
  if (action === 'toggle') {
    const held = db
      .prepare('SELECT 1 FROM guest_badges WHERE guest_id = ? AND badge_id = ?')
      .get(id, badge.id);
    effective = held ? 'remove' : 'award';
  }

  if (effective === 'remove') {
    scoring.removeSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Removed badge "' + badge.name + '".');
  } else {
    scoring.awardSpecialBadge(id, code);
    redirectWithMsg(res, '/admin/guests', 'Awarded badge "' + badge.name + '".');
  }
});

// POST /admin/badges  — create a new host-defined CUSTOM badge.
// Body: name (required), art_path (required, non-empty — an image path or an
// emoji string), description (optional).
// Always creates type = 'custom' — this route can never be used to create a
// 'metric'/'transferable' catalog row (those are seeded by scripts/seed.js
// only, keyed to a registry function in src/services/badges.js). The code is
// derived from the name (uppercased, non-alnum stripped) so the admin never
// has to invent a machine code by hand; scoring.createCustomBadge's UNIQUE
// constraint on `code` still guards against a collision.
router.post('/badges', (req, res) => {
  const name = (req.body.name || '').trim();
  const artPath = (req.body.art_path || '').trim();
  const description = (req.body.description || '').trim();

  if (!name) {
    return redirectWithMsg(res, '/admin/guests', 'A custom badge needs a name.');
  }
  if (!artPath) {
    return redirectWithMsg(
      res,
      '/admin/guests',
      'A custom badge needs art (an image path or emoji).'
    );
  }

  const code = name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '')
    .slice(0, 40);
  if (!code) {
    return redirectWithMsg(
      res,
      '/admin/guests',
      'That name has no usable characters for a badge code.'
    );
  }

  try {
    const badge = scoring.createCustomBadge({ code, name, type: 'custom', artPath, description });
    if (!badge) {
      return redirectWithMsg(
        res,
        '/admin/guests',
        'Refused: custom badges cannot be metric/transferable.'
      );
    }
    redirectWithMsg(res, '/admin/guests', 'Created custom badge "' + badge.name + '".');
  } catch (err) {
    if (err && err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return redirectWithMsg(res, '/admin/guests', 'A badge with that code already exists.');
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /admin/poster  — the one shared entry-link poster (issue #244). One QR
// pointing at GET /join, printed once instead of a hundred personal
// place-cards — every guest scans the SAME code, then signs themselves up.
// ---------------------------------------------------------------------------
router.get('/poster', async (req, res, next) => {
  try {
    const base = config.BASE_URL.replace(/\/+$/, '');
    const joinUrl = base + '/join';
    // qr.qrDataUrl returns a PNG data-URI string we can drop into <img src>.
    const dataUri = await qr.qrDataUrl(joinUrl);

    res.render('admin-poster', {
      title: 'Entry Poster',
      joinUrl,
      qr: dataUri,
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
  const rows = tasks.map((t, idx) => {
    // resolveTaskBadge lazily inserts the task's own badge row (default
    // ribbon art) the first time a task's card is rendered (issue #483) —
    // every task always has a badge to show, never a missing-badge branch.
    const badge = taskBadges.resolveTaskBadge(t.id);
    return {
      id: t.id,
      title: t.title,
      description: t.description || '',
      sort_order: t.sort_order,
      is_active: t.is_active,
      submissions: subStmt.get(t.id).n,
      isFirst: idx === 0,
      isLast: idx === tasks.length - 1,
      badge: Object.assign({}, taskBadges.toTaskBadgeView(badge), {
        // "Still the default" drives whether the upload control shows
        // (AC10) — compared by path, not by a separate stored flag, so it
        // can never desync from what art_path actually renders.
        isDefault: badge.art_path === taskBadges.DEFAULT_RIBBON_ART_PATH,
      }),
    };
  });

  res.render('admin-tasks', {
    title: 'Tasks',
    tasks: rows,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/tasks  — create a task. Bottom of the order by default; the
// "Add to top" checkbox (issue #258) puts it at position 1 so a mid-event
// task can be featured without a click-reload reorder marathon.
router.post('/tasks', (req, res) => {
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  if (!title) {
    return redirectWithMsg(res, '/admin/tasks', 'A task needs a title.');
  }
  let order;
  if (req.body.add_to_top) {
    const minRow = db.prepare('SELECT MIN(sort_order) AS m FROM tasks').get();
    order = (minRow.m == null ? 1 : minRow.m) - 1;
  } else {
    const maxRow = db.prepare('SELECT MAX(sort_order) AS m FROM tasks').get();
    order = (maxRow.m == null ? -1 : maxRow.m) + 1;
  }
  db.prepare(
    'INSERT INTO tasks (title, description, sort_order, is_active) VALUES (?, ?, ?, 1)'
  ).run(title, description, order);
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
  redirectWithMsg(res, '/admin/tasks', 'Task updated.', 'task-' + id);
});

// POST /admin/tasks/:id/badge  — set a task's badge name and/or art (issue
// #483). Runs photos.uploadBadgeArt directly with an explicit callback (same
// pattern POST /join uses for photos.uploadAvatar), so a fileFilter/size
// rejection surfaces as a flash message instead of an uncaught rejection
// (Express 4 does not catch async-handler rejections; issue #187). Body:
// name (optional — blank leaves the existing name unchanged); the "badge_art"
// file field is optional too — a name-only or art-only submit is valid, and
// setTaskBadge (src/services/task-badges.js) leaves whichever field is
// blank/absent unchanged rather than clearing it.
router.post('/tasks/:id/badge', (req, res, next) => {
  const id = parseInt(req.params.id, 10);
  photos.uploadBadgeArt(req, res, async (err) => {
    if (err) {
      return redirectWithMsg(
        res,
        '/admin/tasks',
        err.message || 'That badge art could not be uploaded.',
        'task-' + id
      );
    }

    const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
    if (!task) {
      return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
    }

    const name = (req.body.name || '').trim();
    try {
      let artPath;
      if (req.file && req.file.buffer && req.file.buffer.length) {
        // saveBadgeArt returns a bare filename (relative to UPLOADS_DIR, like
        // every other photos.js upload); build the public path the same way
        // avatars do at render time, via urlForOriginal, rather than
        // hand-concatenating "/uploads/" here — one owner of that URL shape.
        const filename = await photos.saveBadgeArt(req.file.buffer);
        artPath = photos.urlForOriginal(filename);
      }
      taskBadges.setTaskBadge(id, { name, artPath });
      redirectWithMsg(res, '/admin/tasks', 'Badge updated.', 'task-' + id);
    } catch (saveErr) {
      next(saveErr);
    }
  });
});

// POST /admin/tasks/:id/delete  — delete a task and its photo files.
// ON DELETE CASCADE removes submission rows AND the task's own badges row,
// but NOT any files on disk. Hard-delete each submission's files first so no
// orphaned originals or thumbnails remain (and so direct-URL access is
// closed — the file is gone).
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

  // Resolve the task's badge art BEFORE the DELETE below — ON DELETE CASCADE
  // removes the badges row along with the task, and its art_path cannot be
  // read back afterward (issue #501). Uses the non-lazy getTaskBadge (not
  // resolveTaskBadge): a task that was never customized (and never had its
  // admin card rendered) may have no badges row at all, and there is no
  // reason to insert one here just to unlink nothing and immediately cascade
  // it away. unlinkUploadedArt no-ops on the shared default ribbon SVG, same
  // policy as the avatar cleanup above (guest delete).
  const badge = taskBadges.getTaskBadge(id);
  if (badge) {
    try {
      taskBadges.unlinkUploadedArt(badge.art_path);
    } catch (err) {
      console.error('Failed to delete badge art for task', id, err);
    }
  }

  db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  // No anchor: the card this id pointed at no longer exists.
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
    next ? 'Task is now active.' : 'Task is now hidden from guests.',
    'task-' + id
  );
});

// POST /admin/tasks/reorder  — move one task up or down by swapping sort_order
// with its neighbor, or straight to the top. Body: id = task id,
// direction = "up" | "down" | "top". Every outcome redirects back to
// #task-<id> so the admin lands on the card they moved, not the page top.
router.post('/tasks/reorder', (req, res) => {
  const id = parseInt(req.body.id, 10);
  const direction = (req.body.direction || '').trim();

  const task = db.prepare('SELECT id, sort_order FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }

  if (direction === 'top') {
    // One statement, atomic: take a sort_order below the current minimum.
    // (If the task is already the minimum it just gets min-1 — still first.)
    db.prepare(
      'UPDATE tasks SET sort_order = (SELECT MIN(sort_order) FROM tasks) - 1 WHERE id = ?'
    ).run(id);
    return redirectWithMsg(res, '/admin/tasks', 'Task moved to the top.', 'task-' + id);
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
    return redirectWithMsg(res, '/admin/tasks', 'Task is already at the edge.', 'task-' + id);
  }

  // Swap the two sort_order values inside a transaction.
  const swap = db.transaction(() => {
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(neighbor.sort_order, task.id);
    db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?').run(task.sort_order, neighbor.id);
  });
  swap();
  redirectWithMsg(res, '/admin/tasks', 'Task moved.', 'task-' + id);
});

// ---------------------------------------------------------------------------
// GET /admin/photos  — ALL submissions, including taken-down ones
// ---------------------------------------------------------------------------
router.get('/photos', (req, res) => {
  // LEFT JOIN tasks (not JOIN): a memory (issue #247, s.task_id IS NULL) has
  // no task row to join — it must still appear here (so admins can award its
  // per-photo bonus, AC5) with task_title coming back NULL; the view falls
  // back to the literal "Memory" label.
  const photoRows = db
    .prepare(
      `SELECT s.id          AS id,
              s.task_id      AS task_id,
              s.photo_path   AS photo_path,
              s.thumb_path   AS thumb_path,
              s.caption      AS caption,
              s.taken_down   AS taken_down,
              s.resubmitted  AS resubmitted,
              s.photo_bonus  AS photo_bonus,
              s.created_at   AS created_at,
              g.id           AS guest_id,
              g.name         AS guest_name,
              t.title        AS task_title
         FROM submissions s
         JOIN guests g ON g.id = s.guest_id
         LEFT JOIN tasks  t ON t.id = s.task_id
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

// POST /admin/photos/:id/points  — set a photo's bonus points (issue #89).
// Body: bonus = the new photo_bonus value.
// This is an ABSOLUTE SET (submissions.photo_bonus = bonus), unlike the
// per-guest points route above, which is additive (bonus_points = bonus_points
// + delta). A photo's award is a single Wedding Master judgment on that one
// photo, replaced whenever re-judged — there is no "stack of past awards" to
// accumulate, so a set is the natural operation, not a delta.
// Only a non-negative integer is accepted; anything else redirects with a
// message and writes nothing, leaving the stored value unchanged.
router.post('/photos/:id/points', (req, res) => {
  const id = parseInt(req.params.id, 10);

  const submission = db.prepare('SELECT id FROM submissions WHERE id = ?').get(id);
  if (!submission) {
    return redirectWithMsg(res, '/admin/photos', 'Submission not found.');
  }

  // Accept only a bare non-negative integer string (e.g. "0", "4", "12"). This
  // regex rejects decimals, signs, whitespace-padded junk, and non-numeric
  // input in one guard, rather than relying on parseInt's lenient prefix
  // parsing (which would silently accept "4abc" as 4).
  const raw = typeof req.body.bonus === 'string' ? req.body.bonus.trim() : '';
  if (!/^\d+$/.test(raw)) {
    return redirectWithMsg(res, '/admin/photos', 'Enter a whole number of 0 or more.');
  }
  const bonus = parseInt(raw, 10);

  db.prepare('UPDATE submissions SET photo_bonus = ? WHERE id = ?').run(bonus, id);
  redirectWithMsg(res, '/admin/photos', 'Set photo points bonus to ' + bonus + '.');
});

// ---------------------------------------------------------------------------
// GET /admin/comments  — recent comments (any taken_down state), joined to
// the commenter's name and the photo/task they were left on.
// ---------------------------------------------------------------------------
router.get('/comments', (req, res) => {
  // LEFT JOIN tasks (not JOIN): a comment can be left on a memory (issue
  // #247, s.task_id IS NULL) via the same feed comment form task photos use.
  // An inner join here would silently drop that comment from this moderation
  // list — LEFT JOIN keeps it, with task_title coming back NULL; the view
  // falls back to "a shared memory".
  const commentRows = db
    .prepare(
      `SELECT c.id            AS id,
              c.body          AS body,
              c.taken_down    AS taken_down,
              c.created_at    AS created_at,
              g.id            AS guest_id,
              g.name          AS guest_name,
              s.id            AS submission_id,
              t.title         AS task_title
         FROM comments c
         JOIN guests g      ON g.id = c.guest_id
         JOIN submissions s ON s.id = c.submission_id
         LEFT JOIN tasks t  ON t.id = s.task_id
        ORDER BY c.created_at DESC, c.id DESC`
    )
    .all();

  res.render('admin-comments', {
    title: 'Comments',
    comments: commentRows,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/comments/:id/hide  — hide a comment (taken_down = 1).
//
// Comment moderation uses "hide", not the "takedown" verb the photo routes
// use, because the two actions are not the same operation. A photo takedown
// removes a SCORED submission: it must recompute the guest's auto-badges in a
// transaction (photos.hideSubmission), because a hidden photo can no longer
// count toward points or badges. A comment carries no score and no badge, so
// hiding one is lighter, text-only moderation — a plain taken_down flag flip
// with no scoring side effect. The different verb marks the different weight.
router.post('/comments/:id/hide', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(id);
  if (!comment) {
    return redirectWithMsg(res, '/admin/comments', 'Comment not found.');
  }
  db.prepare('UPDATE comments SET taken_down = 1 WHERE id = ?').run(id);
  redirectWithMsg(res, '/admin/comments', 'Comment hidden.');
});

// POST /admin/comments/:id/restore  — restore a hidden comment (taken_down = 0).
router.post('/comments/:id/restore', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const comment = db.prepare('SELECT id FROM comments WHERE id = ?').get(id);
  if (!comment) {
    return redirectWithMsg(res, '/admin/comments', 'Comment not found.');
  }
  db.prepare('UPDATE comments SET taken_down = 0 WHERE id = ?').run(id);
  redirectWithMsg(res, '/admin/comments', 'Comment restored.');
});

// ---------------------------------------------------------------------------
// GET /admin/bugs  — bug report queue (issue #245). Unresolved reports first
// (newest first within that group), then resolved reports collapsed at the
// bottom (also newest first) — one ORDER BY does both: resolved=0 sorts
// before resolved=1, and created_at DESC breaks ties inside each group.
// ---------------------------------------------------------------------------
router.get('/bugs', (req, res) => {
  const reports = db
    .prepare(
      `SELECT r.id          AS id,
              r.body        AS body,
              r.page        AS page,
              r.resolved    AS resolved,
              r.created_at  AS created_at,
              g.id          AS guest_id,
              g.name        AS guest_name
         FROM bug_reports r
         JOIN guests g ON g.id = r.guest_id
        ORDER BY r.resolved ASC, r.created_at DESC, r.id DESC`
    )
    .all();

  res.render('admin-bugs', {
    title: 'Bugs',
    reports,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/bugs/:id/resolve  — mark a bug report resolved. One-way (there
// is no "reopen" affordance per the design), so this always sets resolved to
// 1 rather than toggling.
router.post('/bugs/:id/resolve', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const report = db.prepare('SELECT id FROM bug_reports WHERE id = ?').get(id);
  if (!report) {
    return redirectWithMsg(res, '/admin/bugs', 'Bug report not found.');
  }
  db.prepare('UPDATE bug_reports SET resolved = 1 WHERE id = ?').run(id);
  redirectWithMsg(res, '/admin/bugs', 'Bug report resolved.');
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
