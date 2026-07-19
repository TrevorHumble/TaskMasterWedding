// src/app.js
// Express bootstrap for Wedding Master.
//
// All config reads below use the canonical UPPER_SNAKE_CASE keys from config.js.

const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('../config');
const photos = require('./services/photos');
const initials = require('./utils/initials');
const { db } = require('./db');

const app = express();

// ---------------------------------------------------------------------------
// Process-level crash guards (issue #311). Deliberately at MODULE scope --
// runs the moment this file is require()'d, NOT inside the startup guard
// down in section 9 below (only true when this file is the process entry
// point) -- so a test that loads the app (tests/helpers/testApp.js's
// loadApp) and then emits a synthetic unhandledRejection always finds a
// handler already attached, and so a real require of this module from any
// entrypoint (the server, a script, a test) is protected the same way.
// (Deliberately NOT spelling out that guard's exact condition in this
// comment -- several tests, including this file's own AC5/AC6 checks below,
// locate it in the source via its literal text, and an incidental second
// occurrence of that phrase up here would shift what `indexOf` finds first.)
//
// Before this, there was no process.on('unhandledRejection'/
// 'uncaughtException') anywhere in src/ (grepped) -- src/routes/guest.js's
// await submissions.submitPhoto(...) call inside an async multer callback
// was NOT wrapped in try/catch (fixed separately, in that file, for AC1), so
// a throw there escaped as an unhandled rejection straight past Express's
// own error handler (section 8 below) and, on Node >= 15, TERMINATED THE
// PROCESS -- a full outage for every guest at once until
// scripts/serve-resilient.js relaunched it.
//
// The two guards below make two DIFFERENT choices on purpose:
//
//   unhandledRejection: log and KEEP RUNNING. This is the guest-facing
//   server for the whole reception -- "one bad promise costs one broken
//   request," not a full-app outage for every other guest mid-celebration.
//   AC1's try/catch already closes the one throw surface #311 found, so a
//   rejection reaching this handler at all means some OTHER, not-yet-
//   anticipated path escaped a catch; logging it is exactly the missing
//   signal the #311 evidence called out ("an operator watching the console
//   has zero signal").
//
//   uncaughtException: log, then EXIT. Node's own docs warn the process is
//   in an undefined state once this fires (https://nodejs.org/api/process.html
//   #event-uncaughtexception) -- continuing to serve requests against
//   possibly-corrupted state is not a safer choice than restarting.
//   scripts/serve-resilient.js already exists to relaunch this process on
//   any unexpected exit, so "exit and let the wrapper restart" is the same
//   bounded, brief outage the app already tolerates today, not a new cost.
//
// Guarded against double registration: this module can load more than once
// within one Node process (e.g. a test suite that evicts it from
// require.cache and re-requires it, per tests/hosting-lifecycle.test.js's
// reloadAppWithFreshConfig). The guard flag lives on `process` itself
// (outlives any one module instance) so a second load never attaches a
// second pair of listeners.
// ---------------------------------------------------------------------------
if (!process.__gppCrashGuardsInstalled) {
  process.__gppCrashGuardsInstalled = true;

  process.on('unhandledRejection', (reason) => {
    console.error('[app] unhandledRejection:', reason);
  });

  process.on('uncaughtException', (err) => {
    console.error('[app] uncaughtException:', err);
    process.exit(1);
  });
}

// ---------------------------------------------------------------------------
// 0. Trust proxy. Hosted deployment (DESIGN.md § Hosted deployment) sits
//    behind a reverse proxy that terminates TLS and forwards the real client
//    address in X-Forwarded-For. config.TRUST_PROXY is the hop count to
//    trust (see config.js for the parsing rule); false (the unset/local-dev
//    case) is left as Express's own default rather than explicitly disabled.
// ---------------------------------------------------------------------------
if (config.TRUST_PROXY !== false) app.set('trust proxy', config.TRUST_PROXY);

// Make the initials helper available to every EJS template as a callable local,
// so avatar fallbacks across guest-home, public-profile, and leaderboard all
// derive initials from the same function rather than inline one-liners.
app.locals.initials = initials;

// ---------------------------------------------------------------------------
// 1. Make sure the data directories exist before anything tries to use them.
// ---------------------------------------------------------------------------
function ensureDataDirs() {
  const dirs = [config.DATA_DIR, config.UPLOADS_DIR, config.THUMBS_DIR, config.EXPORTS_DIR];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      console.log('[app] created directory:', dir);
    }
  }
}
ensureDataDirs();

// ---------------------------------------------------------------------------
// 2. View engine: EJS, views live in src/views.
// ---------------------------------------------------------------------------
app.set('view engine', 'ejs');
app.set('views', config.VIEWS_DIR);

// ---------------------------------------------------------------------------
// 3. Core middleware.
// ---------------------------------------------------------------------------
// Parse form posts (multipart photo uploads are handled separately by multer
// in the routes that need it).
//
// Explicit 16kb limit on both parsers (issue #553). Bounds per-frame memory
// on the unauthenticated bcrypt path: POST /admin/login runs bcrypt.compare
// on the main thread for every caller before anyone is known to be the real
// admin (issue #543's CPU-bound gate), and body-parser's own 100 KB default
// would otherwise let an attacker pin an ~100 KB password per accumulated
// request frame -- ~600x the ~170 bytes a real credential costs -- on a
// ~2 GB host under a login flood. 16kb leaves at least an order of magnitude
// of headroom over every real form field in src/views/ (AC4).
app.use(express.urlencoded({ extended: false, limit: '16kb' }));
app.use(express.json({ limit: '16kb' }));
// 413 passthrough (issue #553). body-parser signals an over-limit body by
// calling next(err) with a 413 PayloadTooLargeError (err.type ===
// 'entity.too.large'), but the catch-all error handler below (section 8)
// renders a 500 for EVERY error -- so without this, an oversized body from
// either parser above would surface as 500, not the 413 AC2/AC3 require.
// This only sees errors from middleware registered before it (the two
// parsers above), so a malformed-JSON 400 or any other route/error still
// falls through to the catch-all unchanged -- no regression there.
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    res.status(413).render('error', {
      message: 'That request was too large. Please try again.',
    });
    return;
  }
  next(err);
});
// Signed cookies. The same secret signs the guest (gsid) and admin cookies.
app.use(cookieParser(config.COOKIE_SECRET));
// Response header: keep every page and file out of search-engine indexes
// (DESIGN.md § Hosted deployment). Runs ahead of the static mounts (section 4)
// on purpose so it also covers /uploads and /thumbs — photo files have no
// HTML to carry a meta tag, so the header is their only indexing signal.
app.use((req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});

// ---------------------------------------------------------------------------
// 4. Static file mounts.
//    /        -> src/public  (css, js, badges)
//    /uploads -> data/uploads (full-size originals + avatars)
//    /thumbs  -> data/thumbs  (thumbnails)
// ---------------------------------------------------------------------------
app.use(express.static(config.PUBLIC_DIR));
app.use(config.UPLOADS_URL_BASE, photos.blockTakenDownOriginal, express.static(config.UPLOADS_DIR));
app.use('/thumbs', photos.blockTakenDownThumb, express.static(config.THUMBS_DIR));

// ---------------------------------------------------------------------------
// 4a. Liveness probe. Placed before maintenance mode (4b) and attachGuest (5)
//     so the hosting platform's health checks never see the 503 maintenance
//     page and never pay the cost of guest-session lookup. Also placed ahead
//     of the rate limiter #283 introduces (routers below), so /healthz is
//     never rate-limited -- that falls out of this placement, not extra code.
//     A live SELECT against the DB makes this a readiness probe, not just a
//     process-alive probe: a wedged/corrupt DB fails the platform's check.
// ---------------------------------------------------------------------------
app.get('/healthz', (req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ ok: true, commit: config.GIT_SHA });
  } catch {
    res.status(503).json({ ok: false, commit: config.GIT_SHA });
  }
});

// ---------------------------------------------------------------------------
// 4b. Maintenance mode.
//     When config.MAINTENANCE is true, respond 503 to every guest path.
//     /admin paths and the static assets already served above fall through.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (!config.MAINTENANCE) return next();
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return next();
  return res.status(503).set('Retry-After', '120').render('maintenance');
});

// ---------------------------------------------------------------------------
// 5. attachGuest middleware.
//    Reads the signed gsid cookie and loads the guest into res.locals.
// ---------------------------------------------------------------------------
const session = require('./middleware/session');
app.use(session.attachGuest);

// ---------------------------------------------------------------------------
// 6. Routers. Each is an express.Router(). IMPORTANT: admin.js mounts at
//    '/admin' (its routes are written relative to /admin); every other router
//    mounts at '/'.
// ---------------------------------------------------------------------------
const authRouter = require('./routes/auth'); // mounts at '/'  (public links, onboarding, admin login)
app.use('/', authRouter);

// admin.js MUST be before guest.js: guest.js applies requireGuest to every
// path under '/', which would otherwise intercept /admin and redirect
// signed-out admins to /join.
const adminRouter = require('./routes/admin'); // mounts at '/admin'
app.use('/admin', adminRouter);

const guestRouter = require('./routes/guest'); // mounts at '/'
app.use('/', guestRouter);

const communityRouter = require('./routes/community'); // mounts at '/'
app.use('/', communityRouter);

// ---------------------------------------------------------------------------
// 7. 404 handler. Any request that matched no route lands here.
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('404', { url: req.originalUrl });
});

// ---------------------------------------------------------------------------
// 8. Error handler. Express recognizes this by its FOUR arguments.
//    Anything that throws or calls next(err) lands here.
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[app] unhandled error:', err);
  res.status(500).render('error', {
    message: 'Something went wrong on our end. Please try again.',
  });
});

// ---------------------------------------------------------------------------
// 9. Start listening.
// ---------------------------------------------------------------------------
if (require.main === module) {
  const server = app.listen(config.PORT, () => {
    console.log('');
    console.log('  Wedding Master is running.');
    console.log('  Local:   http://localhost:' + config.PORT);
    if (config.BASE_URL) {
      console.log('  Public:  ' + config.BASE_URL);
    }
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });

  // Drain in-flight requests and close the DB cleanly on a platform restart
  // or deploy (SIGTERM) or a local Ctrl+C (SIGINT). See src/utils/shutdown.js.
  // SIGTERM is a no-op on Windows dev machines but is exactly what Linux
  // hosts send on every deploy, so registering it here is harmless locally
  // and load-bearing in production.
  const { installShutdownHandlers } = require('./utils/shutdown');
  const shutdown = installShutdownHandlers(server, { db });
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = app;
