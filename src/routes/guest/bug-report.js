// src/routes/guest/bug-report.js
// GET/POST /bug-report — the "Report a bug" form (issue #991 split, seam
// table area "bug-report.js").

'use strict';

const express = require('express');
const router = express.Router();

const config = require('../../../config');

// db.js exports an OBJECT { db, getGuestByToken, getGuestById, ... }.
// insertBugReportOnce (issue #1020) is the shared owner of the double-submit
// guard, the BUG_REPORT_BODY_MAX clamp, and the INSERT itself, all moved to
// src/db/bug-reports.js so POST /bug-report and POST /error-report share one
// copy of each instead of hand-rolling it.
const { insertBugReportOnce } = require('../../db');

// setFlash is the shared one-shot flash writer, the single owner of the
// signed `flash` cookie's shape.
const { setFlash } = require('../../middleware/session');

const { withBadgeMoment } = require('../../services/render-locals');

// socialRateLimiter (shared with POST /recap/seen and POST
// /badge-moment/celebrated, see src/routes/guest/shared.js) — one combined
// per-guest budget, config.RATE_LIMIT_SOCIAL_MAX. refererPath (issue #1020)
// also moved here from this file, shared with POST /error-report.
const { socialRateLimiter, refererPath } = require('./shared');

// Copy shown to the guest after a bug report is stored (AC1) and when the
// body field is left empty (AC5). Named constants so the route and the tests
// reference the same literal in one place. Variant-aware (issue #640 AC3):
// read once at module load, same as task-badges.js's DEFAULT_RIBBON_ART_PATH
// — config.VARIANT never changes for the lifetime of a running process, so
// this never needs to be re-evaluated per request.
const BUG_REPORT_THANKS =
  config.VARIANT === 'stag'
    ? 'Thanks — the Stag Masters have been told.'
    : 'Thanks — the Wedding Masters have been told.';
const BUG_REPORT_EMPTY_ERROR = 'Tell us what went wrong first.';
// The BUG_REPORT_BODY_MAX clamp (an unbounded report count is a known,
// accepted minor under the guest-comments threat model) and the #889
// double-submit window now live in src/db/bug-reports.js (issue #1020).
// See insertBugReportOnce's own doc comment there. refererPath moved to
// ./shared for the same reason (POST /error-report needs it too).

// ---------------------------------------------------------------------------
// GET /bug-report  — the "Report a bug" form (issue #245). Guest-gated by the
// src/routes/guest.js router.use(requireGuest), same as every route mounted
// there (AC2: a signed-out visitor is redirected to /join instead — issue #241).
// ---------------------------------------------------------------------------
router.get('/bug-report', function (req, res) {
  res.render('bug-report', withBadgeMoment(req, res, { title: 'Report a bug', error: '' }));
});

// ---------------------------------------------------------------------------
// POST /bug-report  — store a guest's bug report (issue #245).
// The app auto-attaches guest id, the referring path (Referer header, origin
// stripped), and the User-Agent — the guest form itself carries only the
// message body, per the design ("no email field, no screenshot upload").
// ---------------------------------------------------------------------------
router.post('/bug-report', socialRateLimiter, function (req, res) {
  const guest = res.locals.guest;

  const raw = typeof req.body.body === 'string' ? req.body.body : '';
  const trimmed = raw.trim();

  // AC5: an empty (or whitespace-only) body inserts no row and re-renders the
  // form with the required error copy.
  if (trimmed.length === 0) {
    return res.render(
      'bug-report',
      withBadgeMoment(req, res, { title: 'Report a bug', error: BUG_REPORT_EMPTY_ERROR })
    );
  }

  // AC6: insertBugReportOnce (src/db/bug-reports.js) truncates to
  // BUG_REPORT_BODY_MAX chars: 1001 'a' characters store as exactly 1000.
  const body = trimmed;

  const page = refererPath(req.get('referer'));
  const userAgent = req.get('user-agent') || null;

  // Issue #889 AC3/AC4's duplicate-window guard, now inside insertBugReportOnce
  // (src/db/bug-reports.js, issue #1020). See its own doc comment for the
  // dedupe rule and the `guest_id IS ?` predicate.
  insertBugReportOnce({ guestId: guest.id, body, page, userAgent });

  setFlash(res, 'success', BUG_REPORT_THANKS);
  return res.redirect('/');
});

module.exports = router;
