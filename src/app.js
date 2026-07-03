// src/app.js
// Express bootstrap for Garden Party Pastels.
//
// All config reads below use the canonical UPPER_SNAKE_CASE keys from config.js.

const fs = require('fs');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('../config');
const photos = require('./services/photos');
const initials = require('./utils/initials');

const app = express();

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
// path under '/', which would otherwise intercept /admin and bounce admins
// to the "private link needed" page.
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
  app.listen(config.PORT, () => {
    console.log('');
    console.log('  Garden Party Pastels is running.');
    console.log('  Local:   http://localhost:' + config.PORT);
    console.log('  Press Ctrl+C to stop.');
    console.log('');
  });
}

module.exports = app;
