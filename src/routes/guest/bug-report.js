// src/routes/guest/bug-report.js
// GET/POST /bug-report — the "Report a bug" form (issue #991 split, seam
// table area "bug-report.js").

'use strict';

const express = require('express');
const router = express.Router();

const config = require('../../../config');

// db.js exports an OBJECT { db, getGuestByToken, getGuestById, ... }.
// Destructure the better-sqlite3 connection itself, or db.prepare(...) is
// undefined.
const { db } = require('../../db');

// setFlash is the shared one-shot flash writer, the single owner of the
// signed `flash` cookie's shape.
const { setFlash } = require('../../middleware/session');

const { withBadgeMoment } = require('../../services/render-locals');

// socialRateLimiter (shared with POST /recap/seen and POST
// /badge-moment/celebrated, see src/routes/guest/shared.js) — one combined
// per-guest budget, config.RATE_LIMIT_SOCIAL_MAX.
const { socialRateLimiter } = require('./shared');

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
// A stored bug body is capped at this many characters (issue #245 AC6) — long
// enough for a real description. This bounds only the per-request body
// length, not the number of reports a guest can file; an unbounded report
// count is a known, accepted minor under the guest-comments threat model.
const BUG_REPORT_BODY_MAX = 1000;
// Same-guest, same-stored-body reposts inside this window are double-taps or
// refresh-resubmits, not new reports (issue #889); a deliberate repeat filed
// later than this always lands.
const BUG_REPORT_DUPLICATE_WINDOW_SECONDS = 30;

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
  } catch {
    return rawReferer.startsWith('/') ? rawReferer : null;
  }
}

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

  // AC6: truncate to BUG_REPORT_BODY_MAX chars — 1001 'a' characters store as
  // exactly 1000.
  const body = trimmed.slice(0, BUG_REPORT_BODY_MAX);

  const page = refererPath(req.get('referer'));
  const userAgent = req.get('user-agent') || null;

  // Issue #889 AC3/AC4: dedupe on the STORED form of the body (the same
  // trimmed+truncated `body` the INSERT below writes), scoped to this guest
  // and a 30-second window — a double-tap or a refresh-resubmit of the exact
  // same report inserts no second row, while a distinct body (or the same
  // body filed again minutes later) is a real second report and lands
  // normally. The window subtraction compares directly against `created_at`'s
  // own `datetime('now')` storage shape (src/db.js), so no clock parsing is
  // needed on this side. Existence is all that matters — SELECT 1, no ordering.
  const recentDuplicate = db
    .prepare(
      `SELECT 1 FROM bug_reports
        WHERE guest_id = ? AND body = ?
          AND created_at >= datetime('now', '-' || ? || ' seconds')
        LIMIT 1`
    )
    .get(guest.id, body, BUG_REPORT_DUPLICATE_WINDOW_SECONDS);

  // status defaults to 'open' (bug_reports.status, issue #686) — every new
  // report starts open, so this INSERT relies on the column's own DEFAULT
  // instead of naming it. The retired `resolved` column is no longer named
  // here either; it keeps its own 0 default, unread everywhere now.
  if (!recentDuplicate) {
    db.prepare(
      `INSERT INTO bug_reports (guest_id, body, page, user_agent)
       VALUES (?, ?, ?, ?)`
    ).run(guest.id, body, page, userAgent);
  }

  setFlash(res, 'success', BUG_REPORT_THANKS);
  return res.redirect('/');
});

module.exports = router;
