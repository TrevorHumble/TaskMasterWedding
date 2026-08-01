// src/routes/admin/dashboard.js
// Dashboard + checklist + the retired qrsheet path — seam table area
// "dashboard + checklist + qrsheet" (issue #969).

const express = require('express');
const hostChecklist = require('../../services/host-checklist');
const feed = require('../../services/feed');
const { relativeTime } = require('../../services/relative-time');
const { redirectWithMsg, renderNotFound } = require('./shared');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /admin  — dashboard
// ---------------------------------------------------------------------------
router.get('/', (req, res) => {
  // The flat checklist (issue #646): host-checklist.js is the single owner
  // of row definitions, bucket ordering, the bug pin, and the tips gate — it
  // already walks guests/tasks/bug_reports to build those rows, so it is
  // also the single owner of the three stat-grid counts (`stats`, #646).
  // This route consumes buildRows() once and re-queries none of its tables
  // itself.
  const { rows, openCount, urgentCount, stats } = hostChecklist.buildRows();

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
    counts: { guests: stats.guests, activeTasks: stats.activeTasks },
    openBugs: stats.openBugs,
    lastPhoto,
    rows,
    openCount,
    urgentCount,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// ---------------------------------------------------------------------------
// POST /admin/checklist/:id/toggle  — flip one manual checklist item's
// checked state (issue #646 AC5). The only writer of `settings` keys
// `checklist.<id>`.
//
// Writes the OPPOSITE of the `checked` field the form posts back (#646),
// not the opposite of a fresh isManualChecked() read at request
// time — the form's hidden `checked` field carries the state the page
// rendered WITH, so a double-tap (two rapid submits of the same rendered
// button, before the first redirect lands) posts the identical `checked`
// value twice and both requests compute the identical target state, landing
// idempotently instead of one flip cancelling the other. A malformed or
// missing `checked` field (a stale/hand-crafted POST) falls back to the
// current DB read, matching the old toggle-on-read behavior rather than
// refusing the request.
// ---------------------------------------------------------------------------
router.post('/checklist/:id/toggle', (req, res) => {
  const id = req.params.id;
  if (!hostChecklist.isValidManualId(id)) {
    return redirectWithMsg(res, '/admin', 'Unknown checklist item.');
  }
  const postedChecked = req.body.checked;
  const asRendered =
    postedChecked === '1' || postedChecked === '0'
      ? postedChecked === '1'
      : hostChecklist.isManualChecked(id);
  hostChecklist.setManualChecked(id, !asRendered);
  redirectWithMsg(res, '/admin', 'Checklist updated.', 'checklist');
});

// GET /admin/qrsheet — RETIRED (issue #244 AC2/AC3), see shared.js's
// renderNotFound doc comment for why this needs the explicit 404 render
// rather than falling through to guest.js's requireGuest 302.
router.get('/qrsheet', renderNotFound);

module.exports = router;
