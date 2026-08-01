// src/routes/guest.js
// Guest router mount (issue #991 split). Every route lives in one of the
// area modules under src/routes/guest/ below; this file only wires the
// whole-router requireGuest gate, then mounts each area in the seam table's
// order.
//
// Area map (which module owns which routes/helpers):
//   guest/shared.js        suppressedChallengeIds + reachableLiveTaskCount
//                          (the one-box-ceiling helpers), uploadRateLimiter +
//                          socialRateLimiter (the two shared route-level
//                          limiters) — issue #991 AC3's single-instance rule
//   guest/home.js          GET /               (home / own-stats page)
//   guest/tasks.js         GET /tasks
//                          GET /tasks/:id
//                          POST /tasks/:id/submit
//   guest/pages.js         GET /how-to-play
//                          GET /how-points-work
//   guest/bug-report.js    GET /bug-report
//                          POST /bug-report
//   guest/memories.js      GET /memories/new
//                          POST /memories
//   guest/profile.js       GET /me/edit
//                          POST /me/edit
//                          POST /me/avatar/delete
//   guest/recap.js         POST /recap/seen
//                          POST /badge-moment/celebrated
//                          GET /recap
//
// withBadgeMoment (src/services/render-locals.js) is the ONE call site every
// res.render() across every area module mounted below (and, via
// src/routes/community.js's own require of the same module, every
// res.render() there too) passes through.
//
// A prose pointer elsewhere in the repo that still names "src/routes/
// guest.js's <route>" degrades gracefully through this map rather than
// dead-ending — see issue #969's own note on the 29-file prose-pointer
// omission parked on #588; this split parks the same class of stale pointer
// the same way (issue #991).
'use strict';

const express = require('express');
const router = express.Router();

// requireGuest comes from section 03. It loads the current guest into
// res.locals.guest (and req.guest) from the signed gsid cookie, or
// redirects visitors who have no valid guest link.
const { requireGuest } = require('../middleware/session');

// Every route mounted below requires a signed-in guest.
router.use(requireGuest);

router.use(require('./guest/home'));
router.use(require('./guest/tasks'));
router.use(require('./guest/pages'));
router.use(require('./guest/bug-report'));
router.use(require('./guest/memories'));
router.use(require('./guest/profile'));
router.use(require('./guest/recap'));

module.exports = router;
