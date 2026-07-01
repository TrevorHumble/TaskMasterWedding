// src/app.js
// Express bootstrap for Garden Party Pastels.
// Boots cleanly even before later sections add the db/routers/middleware:
// optional modules are mounted only if their files are present.
//
// All config reads below use the canonical UPPER_SNAKE_CASE keys from config.js.

const fs = require('fs');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('../config');
const photos = require('./services/photos');

const app = express();

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
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
// Signed cookies. The same secret signs the guest (gsid) and admin cookies.
app.use(cookieParser(config.COOKIE_SECRET));

// ---------------------------------------------------------------------------
// 4. Static file mounts.
//    /        -> src/public  (css, js, badges)
//    /uploads -> data/uploads (full-size originals + avatars)
//    /thumbs  -> data/thumbs  (thumbnails)
// ---------------------------------------------------------------------------
app.use(express.static(config.PUBLIC_DIR));
app.use('/uploads', photos.blockTakenDownOriginal, express.static(config.UPLOADS_DIR));
app.use('/thumbs', photos.blockTakenDownThumb, express.static(config.THUMBS_DIR));

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
// 5. attachGuest middleware (added by section 03).
//    Reads the signed gsid cookie and loads the guest into res.locals.
//    Mounted only if the file exists so the app boots before section 03.
// ---------------------------------------------------------------------------
const sessionPath = path.join(__dirname, 'middleware', 'session.js');
if (fs.existsSync(sessionPath)) {
  const session = require('./middleware/session');
  if (typeof session.attachGuest === 'function') {
    app.use(session.attachGuest);
  }
} else {
  // Until section 03 exists, make sure views that read res.locals.guest /
  // res.locals.flash do not crash.
  app.use((req, res, next) => {
    if (res.locals.guest === undefined) res.locals.guest = null;
    if (res.locals.flash === undefined) res.locals.flash = null;
    next();
  });
}

// ---------------------------------------------------------------------------
// 6. Routers (added by sections 03/04/07/08). Each is an express.Router().
//    Mounted only if its file exists yet. IMPORTANT: admin.js mounts at
//    '/admin' (its routes are written relative to /admin); every other router
//    mounts at '/'.
// ---------------------------------------------------------------------------
function mountRouterIfPresent(relativeFile) {
  const full = path.join(__dirname, 'routes', relativeFile);
  if (fs.existsSync(full)) {
    const router = require('./routes/' + relativeFile.replace(/\.js$/, ''));
    const mountPath = relativeFile === 'admin.js' ? '/admin' : '/';
    app.use(mountPath, router);
    console.log('[app] mounted router:', relativeFile, 'at', mountPath);
  } else {
    console.log('[app] router not present yet (skipped):', relativeFile);
  }
}
mountRouterIfPresent('auth.js'); // section 03  -> mounts at '/'  (public links, onboarding, admin login)
mountRouterIfPresent('admin.js'); // section 08  -> mounts at '/admin'  MUST be before guest.js: guest.js
//   applies requireGuest to every path under '/', which would otherwise
//   intercept /admin and bounce admins to the "private link needed" page.
mountRouterIfPresent('guest.js'); // section 04  -> mounts at '/'
mountRouterIfPresent('community.js'); // section 07  -> mounts at '/'

// ---------------------------------------------------------------------------
// 7. Temporary home route, ONLY used until the guest router (section 04)
//    provides GET /. Once routes/guest.js exists this block is skipped, so
//    the real guest home wins. This keeps "/" from 404ing during early setup.
// ---------------------------------------------------------------------------
if (!fs.existsSync(path.join(__dirname, 'routes', 'guest.js'))) {
  app.get('/', (req, res) => {
    res
      .type('text/plain')
      .send(
        'Garden Party Pastels server is running. ' +
          'Guest and admin pages are added in later build sections.'
      );
  });
}

// ---------------------------------------------------------------------------
// 8. 404 handler. Any request that matched no route lands here.
// ---------------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).render('404', { url: req.originalUrl });
});

// ---------------------------------------------------------------------------
// 9. Error handler. Express recognizes this by its FOUR arguments.
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
// 10. Start listening.
// ---------------------------------------------------------------------------
if (require.main === module) {
  app.listen(config.PORT, () => {
    console.log('');
    console.log('  Garden Party Pastels is running.');
    console.log('  Local:   http://localhost:' + config.PORT);
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });
}

module.exports = app;
