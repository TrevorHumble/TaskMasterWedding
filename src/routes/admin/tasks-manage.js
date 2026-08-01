// src/routes/admin/tasks-manage.js
// Task badge/delete/active/reorder-all — seam table area "tasks manage
// (badge/delete/active/reorder)", the second half of the mandated
// tasks-core/tasks-manage route-boundary cut (issue #969).

const express = require('express');
const { db } = require('../../db');
const scoring = require('../../services/scoring');
const photos = require('../../services/photos');
const tasks = require('../../services/tasks');
const taskBadges = require('../../services/task-badges');
const { redirectWithMsg } = require('./shared');
const { resolveBadgeIcon } = require('./task-form');

const router = express.Router();

// POST /admin/tasks/:id/badge  — set a task's badge name and icon (issue
// #410). The badge-icon picker (src/views/partials/badge-picker.ejs) is the
// ONLY badge source now — no file upload. Body: name (optional — blank
// leaves the existing name unchanged) and icon (a catalog id from
// src/services/badge-icons.js). An unknown/missing icon with no name is
// rejected via the same redirectWithMsg pattern the route used for a
// rejected upload; a name-only submit (icon absent) is still valid and
// leaves art_path unchanged, same as setTaskBadge always allowed.
//
// RETAINED, no longer a live UI path (#682): the picker's
// own submit is now intercepted client-side by admin-tasks.js whenever it was
// opened from the create wizard or the edit popup (the two ONLY ways a host
// reaches the picker today), so in practice this route is never hit from the
// current UI. Kept as a real endpoint anyway for its own direct test coverage
// and as a stable API surface (a future non-JS or automated caller), not
// dead code to prune — a future reader should not "clean this up" expecting
// no caller exists.
router.post('/tasks/:id/badge', (req, res, next) => {
  const id = parseInt(req.params.id, 10);

  // The picker posts application/x-www-form-urlencoded (icon + name), never
  // a file. A multipart request is the old upload path (#410 removed it) —
  // express.urlencoded/json never populate req.body for multipart, so
  // reject explicitly here rather than silently treating it as an empty
  // name-only submit (AC4: "a multipart POST ... is rejected").
  const contentType = req.headers['content-type'] || '';
  if (contentType.indexOf('multipart/form-data') === 0) {
    return redirectWithMsg(
      res,
      '/admin/tasks',
      'Badge art can no longer be uploaded — pick an icon instead.',
      'task-' + id
    );
  }

  const task = db.prepare('SELECT id FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }

  const badgeResolved = resolveBadgeIcon(req.body.icon, req.body.name, { required: false });
  if (!badgeResolved.ok) {
    return redirectWithMsg(res, '/admin/tasks', 'That badge icon is not recognized.', 'task-' + id);
  }

  try {
    taskBadges.setTaskBadge(id, { name: badgeResolved.name, artPath: badgeResolved.artPath });
    redirectWithMsg(res, '/admin/tasks', 'Badge updated.', 'task-' + id);
  } catch (saveErr) {
    next(saveErr);
  }
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
  // Deleting a task shrinks the active set AND cascades away its
  // submissions, so both metric badges (COMPLETIONIST) and the
  // count-based/transferable badges can move (issue #701 AC4) — run the
  // full all-guests recompute, not a Completionist-only shortcut.
  scoring.recomputeAfterTaskChange();
  // No anchor: the card this id pointed at no longer exists.
  redirectWithMsg(res, '/admin/tasks', 'Task deleted.');
});

// POST /admin/tasks/:id/active  — toggle visibility to guests (writes
// special_mode, issue #727 — the route/param name stays "active" for the
// existing form/URL contract; only the underlying column changed).
//
// RETAINED, no longer a live UI path (#682): the redesign's
// Special radio (None/Hidden/One day only, in the create wizard and the edit
// popup) is now the only host-facing way to change special_mode, and it
// saves through POST /admin/tasks/:id/edit, not this route — no current view
// links or posts here. This is now a SECOND UI-less writer of special_mode
// (the edit route is the other), kept as a stable, independently-tested
// toggle endpoint rather than dead code; a future reader should not assume
// some hidden button still calls it.
//
// Its transitions are NOT a plain none<->hidden flip (issue #755 criterion
// 6): a live task un-hides back to 'oneday', not 'none', when it still
// carries a real special_date, per tasks.isRealDateString() — the one owner
// of that combined shape-and-reality check. Falling back to 'none'
// unconditionally would strand an Aug 9/+3 challenge's date behind a mode
// that no longer marks it as one — isSealed() reads the date, not the mode,
// so guests would keep seeing a locked mystery box for a task the board no
// longer shows as dated. Hiding itself never touches special_date/
// special_bonus at all — hide only ever writes special_mode.
router.post('/tasks/:id/active', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const task = db.prepare('SELECT special_mode, special_date FROM tasks WHERE id = ?').get(id);
  if (!task) {
    return redirectWithMsg(res, '/admin/tasks', 'Task not found.');
  }
  const wasLive = tasks.isTaskLive(task);
  let nextMode;
  if (wasLive) {
    nextMode = tasks.MODE_HIDDEN;
  } else {
    nextMode = tasks.isRealDateString(task.special_date) ? tasks.MODE_ONEDAY : tasks.MODE_NONE;
  }
  // live_since (issue #778): this route's two branches are exhaustive over
  // liveness (hide when wasLive, un-hide to a live mode otherwise — never
  // hidden-to-hidden), so "bump" reduces to the single boolean !wasLive —
  // the un-hide branch always resolves nextMode to a live mode (oneday or
  // none), and the hide branch always resolves to MODE_HIDDEN, so there is
  // no third case to weigh against tasks.isTaskLive({special_mode: nextMode})
  // separately.
  db.prepare(
    `UPDATE tasks SET special_mode = ?,
       live_since = CASE WHEN ? THEN datetime('now') ELSE live_since END
     WHERE id = ?`
  ).run(nextMode, wasLive ? 0 : 1, id);
  // Un-hiding grows the active set (can strip a now-stale COMPLETIONIST,
  // issue #701 AC2); hiding shrinks it (can award a newly-earned one, AC3).
  // Either direction needs the same all-guests recompute.
  scoring.recomputeAfterTaskChange();
  redirectWithMsg(
    res,
    '/admin/tasks',
    wasLive ? 'Task is now hidden from guests.' : 'Task is now active.',
    'task-' + id
  );
});

// POST /admin/tasks/reorder-all  — issue #682: persist a full drag-reordered
// task-id list in one write. The admin-tasks.js drag handle lets a card land
// at ANY position, so the client posts its whole current on-screen order
// after every drop and this route re-numbers sort_order 0..n-1 to match it
// exactly. Called via fetch (JSON body), not a page form post — a full
// navigation after a drag-drop the DOM already reflects would be a jarring
// reload for no reason, so this is the one XHR-style admin route rather than
// a redirect. (The old neighbor-swap POST /admin/tasks/reorder — up/down/top
// — was REMOVED: the redesign deleted its UI, and its sort_order semantics,
// a swap between two existing values, diverged from this route's contiguous
// 0..n-1 renumbering.)
//
// Body (JSON): { order: [taskId, taskId, ...] } — every entry coerced with
// parseInt; a non-integer entry is dropped.
//
// Set-integrity guard: the posted id list, once coerced, MUST
// equal the COMPLETE current set of task ids — same length AND every posted
// id an existing task, with no existing task left out. A stale or partial
// post (e.g. a second drag racing an in-flight first one, or a client bug
// that dropped a card) is refused with no rows touched, rather than
// renumbering only the posted subset 0..n-1 and leaving every omitted task's
// sort_order collided at whatever it already was — a silent, hard-to-notice
// data corruption a full-page reload would then render in an arbitrary order.
// The current-set SELECT that guard reads runs INSIDE the same transaction as
// the write below — better-sqlite3 is synchronous and this
// process is the only writer, so nothing could interleave between a bare
// SELECT-then-UPDATE today, but nesting the read makes that a structural
// guarantee (the whole check-then-write is one atomic unit) rather than an
// argument that happens to hold given today's single-process deployment.
//
// Pure reorder never changes WHICH tasks are active, only their display
// order, so this does NOT call scoring.recomputeAfterTaskChange().
router.post('/tasks/reorder-all', (req, res) => {
  const order = Array.isArray(req.body.order) ? req.body.order : [];
  const ids = order.map((v) => parseInt(v, 10)).filter((n) => Number.isInteger(n));

  if (ids.length === 0) {
    return res.status(400).json({ ok: false, error: 'No task order provided.' });
  }

  const stmtCurrentIds = db.prepare('SELECT id FROM tasks');
  const stmtSetOrder = db.prepare('UPDATE tasks SET sort_order = ? WHERE id = ?');

  // Returns null on a set-mismatch refusal (nothing to apply), or true once
  // the write has been applied — the route below branches on that instead of
  // throwing/catching, since a refusal here is an ordinary, expected outcome
  // (a racing concurrent host), not an exceptional one.
  const applyOrderIfComplete = db.transaction((idList) => {
    const currentIds = stmtCurrentIds.all().map((row) => row.id);
    const postedSet = new Set(idList);
    const currentSet = new Set(currentIds);
    const isCompleteMatch =
      postedSet.size === idList.length && // no duplicate ids in the posted list
      postedSet.size === currentSet.size &&
      currentIds.every((id) => postedSet.has(id));
    if (!isCompleteMatch) {
      return false;
    }
    idList.forEach((taskId, index) => {
      stmtSetOrder.run(index, taskId);
    });
    return true;
  });

  if (!applyOrderIfComplete(ids)) {
    return res
      .status(400)
      .json({ ok: false, error: 'Posted order does not match the current full task set.' });
  }

  res.json({ ok: true });
});

module.exports = router;
