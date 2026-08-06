// src/routes/guest/error-report.js
// POST /error-report: one-tap error reporting from the shared error page
// (issue #1020). Mounts directly in src/app.js, deliberately NOT nested
// inside src/routes/guest.js (whose router.use(requireGuest) would otherwise
// gate it) -- a signed-out visitor who hits a 500 (e.g. an attachGuest DB
// failure before they are ever known) must still be able to file the report,
// same reasoning as src/routes/guest/client-error.js's own mount. Still
// behind the app-wide csrfMiddleware (src/app.js): an urlencoded POST, so no
// multipart carve-out applies, and the double-submit header/field is
// verified the same way as any other unsafe-method request.
//
// This route files into bug_reports (the human-facing admin queue), unlike
// client-error.js's log-only beacon -- see DESIGN.md's #1020 entry for why an
// app-filed report belongs in the same queue a host already checks, composed
// server-side rather than reusing POST /bug-report's free-text form.

'use strict';

const express = require('express');
const router = express.Router();

const { insertBugReportOnce } = require('../../db');

// errorReportRateLimiter (issue #1020) is this route's OWN budget --
// see src/routes/guest/shared.js's own comment for why never
// socialRateLimiter's or clientErrorRateLimiter's.
const { errorReportRateLimiter, refererPath } = require('./shared');

// ERROR_PAGE_MESSAGE and ERROR_REPORT_REJECTED_MESSAGE live in the neutral
// src/error-copy.js, not here -- see that file's own header comment for why
// a leaf feature route must not be the thing src/app.js's global 500 handler
// depends on for its own copy.
const { ERROR_PAGE_MESSAGE, ERROR_REPORT_REJECTED_MESSAGE } = require('../../error-copy');

// The failing request's incident code, minted by request-log.js as 8
// lowercase hex characters (crypto.randomBytes(4).toString('hex')) and
// carried here as a hidden form field, guest-editable, so it is validated
// against that exact shape before it is trusted for anything (AC8). isReqId
// is request-log.js's own predicate for that shape -- imported rather than
// restated here, so a future change to the mint (e.g. a wider randomBytes
// call) can never silently desync this check from what request-log.js
// actually mints. A missing or malformed code inserts nothing.
const { isReqId } = require('../../middleware/request-log');

router.post('/error-report', errorReportRateLimiter, function (req, res) {
  const code = typeof req.body.code === 'string' ? req.body.code : '';

  // AC8: a missing/malformed code inserts nothing and answers 400 with an
  // error page carrying no code (no `reqId` local), so it renders no button
  // and no notice -- the same shape the 413/429/403 sites already produce.
  // `message` is still passed: src/views/error.ejs reads `paragraphs:
  // [message]` with no typeof guard and throws without it. This request was
  // rejected, not a server failure, so it carries ERROR_REPORT_REJECTED_MESSAGE
  // rather than ERROR_PAGE_MESSAGE -- status-accurate copy, like every other
  // rejection site.
  if (!isReqId(code)) {
    return res.status(400).render('error', { message: ERROR_REPORT_REJECTED_MESSAGE });
  }

  const guest = res.locals.guest;
  const page = refererPath(req.get('referer'));
  const userAgent = req.get('user-agent') || null;

  // Composed server-side from server-known facts plus the validated code --
  // a fixed lead-in marking this as app-filed (so a host can tell it apart
  // from a hand-typed POST /bug-report entry), the code, and the failing
  // path. insertBugReportOnce (src/db/bug-reports.js) is the single owner of
  // the BUG_REPORT_BODY_MAX clamp -- this route no longer slices its own copy
  // (refererPath's pathname would otherwise be unbounded).
  const pagePart = page ? ' Page: ' + page + '.' : '';
  const body = 'App-filed error report. Code: ' + code + '.' + pagePart;

  // guest may be null (signed-out visitor, AC7) -- insertBugReportOnce's
  // `guest_id IS ?` guard (src/db/bug-reports.js) treats that the same as any
  // other guest for dedupe purposes.
  insertBugReportOnce({ guestId: guest ? guest.id : null, body, page, userAgent });

  // 200, not a redirect: the POST succeeded and this IS the confirmation page
  // (there is no GET route that could reproduce the original error page).
  // reqId is the SUBMITTED, validated code -- never req.reqId, which is this
  // POST's own fresh id, minted by request-log.js before this handler ever
  // runs.
  return res.status(200).render('error', {
    message: ERROR_PAGE_MESSAGE,
    reqId: code,
    reportSent: true,
  });
});

module.exports = router;
