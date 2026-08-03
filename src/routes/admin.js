// src/routes/admin.js
// Admin router mount (issue #969 split). Every route lives in one of the
// area modules under src/routes/admin/ below; this file only wires the two
// whole-router middlewares, then mounts each area in the seam table's order.
//
// Area map (which module owns which routes/helpers):
//   admin/shared.js        redirectWithMsg + renderNotFound (issue #969 AC1b)
//   admin/task-form.js     create/edit form validation helpers (resolveBadgeIcon,
//                          the one-day/lucky/flash pair-write resolvers, the
//                          exclusivity guard) shared by tasks.js + tasks-manage.js
//   admin/dashboard.js     GET /               (dashboard)
//                          POST /checklist/:id/toggle
//                          GET /qrsheet        (retired -> 404)
//   admin/stats.js         GET /stats          (event stats page, issue #1022)
//   admin/config.js        GET/POST /config    (event timezone + wedding dates)
//   admin/guests.js        POST /guests, /guests/bulk (retired -> 404)
//                          GET /guests, POST /guests/:id/edit, /identity,
//                          /delete, /points, /badge
//   admin/badges-poster.js POST /badges, GET /poster
//   admin/tasks.js         GET /tasks, POST /tasks, POST /tasks/:id/edit
//   admin/tasks-manage.js  POST /tasks/:id/badge, /delete, /active,
//                          POST /tasks/reorder-all
//   admin/task-rank.js     GET/POST /tasks/:id/rank
//   admin/moderation.js    GET /photos, POST /photos/:id/takedown, /restore,
//                          /favorite, /badge (retired), /points (retired),
//                          GET /comments (retired), POST /comments/:id/hide,
//                          /restore
//   admin/bugs-export.js   GET /bugs, POST /bugs/:id/track, /close,
//                          GET /export
//
// A prose pointer elsewhere in the repo that still names "src/routes/admin.js's
// <route>" degrades gracefully through this map rather than dead-ending — see
// issue #969's own note on the 29-file prose-pointer omission parked on #588.
//
// NOTE: GET/POST /admin/login and POST /admin/logout live in routes/auth.js.
//       Do NOT define them here.

const express = require('express');

const { requireAdmin } = require('../middleware/session');

const router = express.Router();

// Guard the whole router. requireAdmin redirects to /admin/login when the
// signed admin cookie is not "1".
router.use(requireAdmin);

// Mark every admin page as an admin context so partials/header.ejs renders the
// ADMIN nav (Dashboard/Tasks/Guests/Photos/Stats/Bugs/Poster/Log out) and the
// logout button, instead of the GUEST nav. Set once here so no individual
// res.render has to remember to pass isAdmin.
router.use((req, res, next) => {
  res.locals.isAdmin = true;
  next();
});

router.use(require('./admin/dashboard'));
router.use(require('./admin/stats'));
router.use(require('./admin/config'));
router.use(require('./admin/guests'));
router.use(require('./admin/badges-poster'));
router.use(require('./admin/tasks'));
router.use(require('./admin/tasks-manage'));
router.use(require('./admin/task-rank'));
router.use(require('./admin/moderation'));
router.use(require('./admin/bugs-export'));

module.exports = router;
