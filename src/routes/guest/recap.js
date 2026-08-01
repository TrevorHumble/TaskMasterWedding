// src/routes/guest/recap.js
// POST /recap/seen, POST /badge-moment/celebrated, GET /recap — the guest
// recap/notifications routes (issue #991 split, seam table area "recap.js").

'use strict';

const express = require('express');
const router = express.Router();

const { getEventConfig } = require('../../db');

// The recap service (issue #644) — owns the recap row/count reads and the
// checkpoint write (POST /recap/seen below).
const notifications = require('../../services/notifications');

// markBadgeCelebrated (issue #902) — the single owner of "does this stamp
// request actually apply", called below by POST /badge-moment/celebrated
// rather than that route hand-writing a second, narrower copy of the owed
// predicate stmtOwedBadges (that module) already owns.
const { markBadgeCelebrated } = require('../../services/render-locals');

// socialRateLimiter (shared with POST /bug-report, see
// src/routes/guest/shared.js) — one combined per-guest budget,
// config.RATE_LIMIT_SOCIAL_MAX.
const { socialRateLimiter } = require('./shared');

// ---------------------------------------------------------------------------
// POST /recap/seen  — advance the signed-in guest's recap checkpoint to now
// (issue #644 plan step 7/9). Fired by src/public/js/recap.js the moment the
// recap panel is opened, from EITHER entry point (the header strip or the
// profile Notifications row) — AC2's "after the guest opens the recap, a
// subsequent render shows no count and no strip" depends entirely on this
// call firing from both. Dismissing the strip (the × button) never calls
// this route — dismiss hides the band for the current page load only and
// must never advance the checkpoint (design: "Dismiss hides, never marks
// read"), so burying an unseen reward is not possible through that control.
// No response body needed; the client does not read one.
// ---------------------------------------------------------------------------
// socialRateLimiter (shared with POST /bug-report in
// src/routes/guest/bug-report.js): a fetch a guest's
// own browser fires automatically the instant the recap panel opens, not a
// form a guest deliberately submits, but still a guest-triggered write with
// no rate limiter of its own before this fix (issue #644 review) — every
// other POST in this router carries one.
router.post('/recap/seen', socialRateLimiter, function (req, res) {
  notifications.markSeen(res.locals.guest.id);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// POST /badge-moment/celebrated — stamp ONE queued badge's celebrated_at for
// the signed-in guest (issue #902 plan step 2). render-locals.js's
// withBadgeMoment already stamps the HEAD of the owed queue at render time,
// exactly as issue #644 always did; this route is what stamps every OTHER
// queued badge (positions 2..K), and only when src/public/js/badge-moment.js
// actually SHOWS one via a Continue tap — never before, and never for the
// head (badge-moment.js never posts for the badge already on screen at
// load). AC3's "abandon keeps it owed" therefore falls out of the client's
// own call discipline (it simply never posts for a badge it never showed),
// not anything this route enforces itself.
//
// The client sends only the badge `code`. The actual guard is
// render-locals.js's markBadgeCelebrated (issue #902 PR review, major
// finding 3) — the single owner of "does this stamp request actually apply,"
// sharing stmtOwedBadges' own owed-predicate shape (celebrated_at IS NULL AND
// a matching badge_granted event exists) rather than this route hand-writing
// a second, narrower copy of it. This route's own job ends at mapping that
// boolean to a status code: a double-tap, a stale/replayed request, a badge
// code this guest does not (or no longer) hold, or another guest's badge
// code all come back `false` (nothing genuinely owed matched) and are
// refused the same way, so there is only one refusal branch, not one per
// cause.
// ---------------------------------------------------------------------------
// socialRateLimiter (shared with POST /bug-report in
// src/routes/guest/bug-report.js and POST /recap/seen
// above): a fetch the guest's own browser fires automatically as each
// queued badge is shown, not a form a guest deliberately fills out, but
// still a guest-triggered write — the same shape POST /recap/seen's own
// comment already gives for carrying this limiter.
router.post('/badge-moment/celebrated', socialRateLimiter, function (req, res) {
  const guest = res.locals.guest;
  const code = typeof req.body.code === 'string' ? req.body.code : '';
  if (!code) {
    return res.status(400).end();
  }

  const stamped = markBadgeCelebrated(guest.id, code);
  if (!stamped) {
    // Not owed to this guest right now (unknown code, someone else's badge,
    // or already celebrated) — refuse rather than silently answering 204, so
    // a client-side bug can never be mistaken for a stamp that actually
    // happened.
    return res.status(404).end();
  }
  return res.status(204).end();
});

// ---------------------------------------------------------------------------
// GET /recap?before=&beforeKey=  — one older page of the signed-in guest's
// recap (issue #644 plan step 7). Omit both for the first page (the same
// page already embedded in header.ejs at initial render — a guest
// re-fetching page one gets the identical shape); pass the last row's
// `when`/`key` values to page further back. `beforeKey` is the composite
// cursor's tie-break (issue #644 review): SQLite's datetime('now') has only
// whole-SECOND precision, so two rows can share the exact same `when` (e.g.
// recomputeBadges granting two badges inside one transaction) — `before`
// alone would either drop or re-serve rows sharing the boundary second.
// notifications.getRecap composes the two into one comparator; a caller that
// omits beforeKey (a stale client, or a manual request) still gets a
// correct — if coarser — page, since getRecap falls back to comparing
// `when` alone when no key is given. 20 rows per page
// (src/services/notifications.js's internal PAGE_SIZE).
// ---------------------------------------------------------------------------
router.get('/recap', function (req, res) {
  const before = typeof req.query.before === 'string' ? req.query.before : undefined;
  const beforeKey = typeof req.query.beforeKey === 'string' ? req.query.beforeKey : undefined;
  // One clock for this request (issue #778) — the announcements source
  // needs it to evaluate live-transition/unseal/flash state. This route
  // resolves its own timezone (the same `getEventConfig().timezone` every
  // other clock-building route across src/routes/guest/ already reads) and
  // hands it to
  // notifications.buildRecapClock, the one place the clock's shape is
  // assembled.
  const clock = notifications.buildRecapClock(getEventConfig().timezone);
  const result = notifications.getRecap(res.locals.guest.id, {
    before: before,
    beforeKey: beforeKey,
    clock: clock,
  });
  res.json(result);
});

module.exports = router;
