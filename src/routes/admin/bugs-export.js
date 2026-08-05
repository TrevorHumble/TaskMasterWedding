// src/routes/admin/bugs-export.js
// Bug report queue (issue #245/#686) + the ZIP/XLSX export (issue 09) —
// seam table area "bugs + export".

const express = require('express');
const config = require('../../../config');
const { db } = require('../../db');
const { streamExportZip } = require('../../services/export');
const { redirectWithMsg } = require('./shared');

const router = express.Router();

// ---------------------------------------------------------------------------
// GET /admin/bugs  — bug report queue (issue #245; three-state lifecycle
// issue #686). Open reports first (newest first within that group), then
// tracked/closed reports collapsed under "Handled" at the bottom (also
// newest first within each) — one ORDER BY does the whole ordering: a CASE
// over status ranks open (0) before tracked (1) before closed (2), and
// created_at DESC breaks ties inside each group. githubRepoUrl feeds the
// view's "Open issue" prefill link; the view builds no repo URL of its own.
// ---------------------------------------------------------------------------
router.get('/bugs', (req, res) => {
  // guest_id is projected from `r`, NOT from `g` (issue #1102). Under the
  // LEFT JOIN below, g.id is NULL both for a genuinely guestless report and
  // for one whose guest row no longer exists — two different facts a
  // guests-side projection cannot tell apart. Projecting from bug_reports
  // keeps guest_id truthful whether or not the join matched, which is what
  // lets admin-bugs.ejs's reporterName render "Guest #<id>" and
  // "Not signed in" as distinct states. See DESIGN.md § "`bug_reports.guest_id`
  // dropped NOT NULL in place, not rebuilt (#1102)".
  const reports = db
    .prepare(
      `SELECT r.id          AS id,
              r.body        AS body,
              r.page        AS page,
              r.status      AS status,
              r.created_at  AS created_at,
              r.guest_id    AS guest_id,
              g.name        AS guest_name
         FROM bug_reports r
         LEFT JOIN guests g ON g.id = r.guest_id
        ORDER BY CASE r.status WHEN 'open' THEN 0 WHEN 'tracked' THEN 1 ELSE 2 END ASC,
                 r.created_at DESC, r.id DESC`
    )
    .all();

  res.render('admin-bugs', {
    title: 'Bugs',
    reports,
    githubRepoUrl: config.GITHUB_REPO_URL,
    msg: req.query.msg || '',
    isAdmin: true,
  });
});

// POST /admin/bugs/:id/track  — mark a bug report tracked (issue #686 AC1):
// the admin used the "Open issue" link, which (per the view's onclick) also
// fires this POST so the report leaves the open queue without the admin
// having to come back and close it separately. Idempotent to call again on
// an already-tracked or already-closed report (it only ever advances
// forward, never reopens) — a duplicate beacon from a flaky network retry is
// harmless.
router.post('/bugs/:id/track', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const report = db.prepare('SELECT id FROM bug_reports WHERE id = ?').get(id);
  if (!report) {
    return redirectWithMsg(res, '/admin/bugs', 'Bug report not found.');
  }
  db.prepare(`UPDATE bug_reports SET status = 'tracked' WHERE id = ?`).run(id);
  redirectWithMsg(res, '/admin/bugs', 'Bug report tracked.');
});

// POST /admin/bugs/:id/close  — mark a bug report closed (issue #686 AC2/AC3).
// Reachable from BOTH open and tracked (a report already on GitHub must be
// closable once it's dealt with, not just a not-an-issue dismissal from
// open) — this route does not check the report's current status, it always
// sets closed. One-way: there is no "reopen" affordance per the design.
router.post('/bugs/:id/close', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const report = db.prepare('SELECT id FROM bug_reports WHERE id = ?').get(id);
  if (!report) {
    return redirectWithMsg(res, '/admin/bugs', 'Bug report not found.');
  }
  db.prepare(`UPDATE bug_reports SET status = 'closed' WHERE id = ?`).run(id);
  redirectWithMsg(res, '/admin/bugs', 'Bug report closed.');
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
