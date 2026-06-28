# 01 — Project Setup, Config, Server Bootstrap, Running & Hosting

This is the first build section. By the end of it you will have a working Express server that boots, creates its data folders, serves static files, shows friendly 404 and error pages, and can be reached from the public internet through a free Cloudflare tunnel. Later sections add the database, auth, photos, etc. This section deliberately does NOT create those files — it only creates the files marked `[01-setup]` in the plan, plus the two placeholder view files (`404.ejs`, `error.ejs`) that the error handlers need.

**Read this whole document once before typing anything.** Then follow the numbered steps in order. Every command is PowerShell (Trevor's machine is Windows 11). Do not chain commands with `&&` — PowerShell does not support it. Run each line on its own.

---

## 0. What you are building in this section

Files you will create (exact paths, all relative to the project root `garden-party-pastels/`):

- `package.json` — dependency list and run scripts
- `.gitignore` — keeps secrets and data out of version control
- `.env.example` — documents the environment variables
- `config.js` — central config object the whole app reads from
- `src/app.js` — the Express server (the heart of this section)
- `scripts/set-admin-password.js` — writes the hashed admin password to `data/admin.hash`
- `src/views/404.ejs` — "page not found" page
- `src/views/error.ejs` — "something went wrong" page

You will also install Node.js, install npm packages, set the admin password, and prove the server runs and is reachable.

> IMPORTANT: Do NOT create `src/db.js`, `scripts/seed.js`, any router files, the middleware, services, or other views in this section. They belong to later sections. `src/app.js` below is written so it boots **even though those files do not exist yet** — it mounts the routers only if their files are present. When later sections add those files, the app will pick them up automatically. Do not "fix" this by inventing those files.

> CONFIG KEY CASING — READ THIS ONCE AND IT WILL SAVE YOU A LOT OF GRIEF.
> Every later section (db, auth, photos, export, admin, the community module) reads
> configuration using **UPPER_SNAKE_CASE** keys — for example `config.DATA_DIR`,
> `config.DB_PATH`, `config.UPLOADS_DIR`, `config.THUMBS_DIR`, `config.EXPORTS_DIR`,
> `config.ADMIN_HASH_PATH`, `config.COOKIE_SECRET`, `config.BASE_URL`,
> `config.MAX_UPLOAD_BYTES`, `config.THUMB_WIDTH`. So `config.js` in this section is the
> single source of truth for those keys and it defines **every** key in UPPER_SNAKE_CASE.
> (A handful of lowercase aliases are also exported purely for backwards compatibility, but
> all code in this plan — including `src/app.js` below — reads the UPPER_SNAKE_CASE names.)
> If you ever see `undefined` where a path should be, you have almost certainly typed a
> config key in the wrong casing. Match the casing exactly.

---

## 1. Install Node.js 20 LTS (one time)

The app requires Node.js 20 LTS. The pinned `better-sqlite3` and `sharp` versions ship prebuilt binaries for Node 20 on Windows x64, so you do **not** need Visual Studio or any C++ build tools.

1. In a browser go to <https://nodejs.org/en/download> and download the **Node.js 20 LTS** Windows Installer (.msi), 64-bit.
2. Run the installer. Accept all defaults. (Leave the "Automatically install the necessary tools" checkbox UNCHECKED — we do not need it.)
3. Open a **new** PowerShell window (so it picks up the new PATH) and verify:

```powershell
node --version
npm --version
```

Expected: `node --version` prints something starting with `v20.` (for example `v20.18.1`). `npm --version` prints a `10.x` number. If `node` is not recognized, close and reopen PowerShell, or reboot, then try again.

---

## 2. Create the project folder

Pick a place to keep the project. The example below uses the Desktop. Use whatever folder you like, but remember the path — every later command assumes you are *inside* the project root.

```powershell
cd $HOME\Desktop
mkdir garden-party-pastels
cd garden-party-pastels
```

From now on, "the project root" means this `garden-party-pastels` folder. Stay in it for all commands unless told otherwise.

Create the empty subfolders the source files live in (npm install will create `node_modules`; boot code will create the `data` folders, but we make the source folders now):

```powershell
mkdir scripts
mkdir src
mkdir src\views
```

---

## 3. Create `package.json`

Create a file named `package.json` in the project root with **exactly** these contents. The dependency versions are pinned and must not be changed — they are the versions chosen because they install cleanly on Windows + Node 20 with no build tools.

```json
{
  "name": "garden-party-pastels",
  "version": "1.0.0",
  "description": "Wedding scavenger hunt web app for Axel Fenwick & Lily Sckeiky.",
  "private": true,
  "type": "commonjs",
  "engines": {
    "node": ">=20 <21"
  },
  "scripts": {
    "start": "node src/app.js",
    "dev": "node src/app.js",
    "seed": "node scripts/seed.js",
    "set-admin": "node scripts/set-admin-password.js"
  },
  "dependencies": {
    "express": "4.21.2",
    "better-sqlite3": "12.2.0",
    "ejs": "3.1.10",
    "multer": "1.4.5-lts.1",
    "sharp": "0.33.5",
    "qrcode": "1.5.4",
    "bcryptjs": "2.4.3",
    "cookie-parser": "1.4.7",
    "archiver": "7.0.1",
    "exceljs": "4.4.0"
  }
}
```

Notes for you (do not put these in the file):
- `start` and `dev` are the same command here. There is no build step and no file-watcher in this stack; `dev` exists so the script name is available. If you want auto-restart while developing, just stop the server with `Ctrl+C` and run `npm start` again.
- `seed` and `set-admin` are convenience aliases. `npm run seed` runs the file that section 02 creates; it will error until then — that is expected.

---

## 4. Install the dependencies

From the project root:

```powershell
npm install
```

This downloads everything in `node_modules`. It can take a few minutes the first time because `sharp` and `better-sqlite3` pull platform binaries. 

Expected result: it finishes with a line like `added 150 packages` and no red `npm ERR!` lines. A few yellow `npm warn deprecated` lines are normal and harmless. If you see an error mentioning `node-gyp`, `MSBuild`, or `Visual Studio`, you almost certainly installed the wrong Node version — confirm `node --version` is `v20.x` and run `npm install` again.

---

## 5. Create `.gitignore`

Create a file named `.gitignore` in the project root with exactly these contents. This keeps installed packages, the live database, uploaded photos, and the secret `.env` out of source control.

```gitignore
# .gitignore
# Installed packages
node_modules/

# All live application state (database, uploaded photos, thumbnails, exports, admin hash)
data/

# Environment secrets
.env

# OS / editor noise
Thumbs.db
.DS_Store
*.log
npm-debug.log*
```

---

## 6. Create `.env.example`

Create a file named `.env.example` in the project root with exactly these contents. This file is a **template** that documents the environment variables — it is safe to commit. The real values go in a `.env` file (which is gitignored) that you create in step 7.

```ini
# .env.example
# Copy this file to ".env" and fill in real values.
# The .env file is gitignored and must NEVER be committed.

# Port the local server listens on. The plan fixes this at 3000.
PORT=3000

# Secret used to SIGN cookies (guest sign-in + admin login).
# Must be a long, random string. If you leave this unset, the app will
# generate a random one at startup and warn you — but then everyone gets
# signed out every time you restart the server. For the wedding weekend,
# set a fixed value here so restarts do not log guests out.
# Generate one with PowerShell:
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
COOKIE_SECRET=

# Base URL printed into guest QR links and place-cards.
# For local testing leave the default. (The public Cloudflare URL changes
# every run, so QR codes are normally generated against the local URL and
# work because guests scan them on the same network / through the tunnel.)
BASE_URL=http://localhost:3000
```

---

## 7. Create your real `.env`

Generate a secret and write a real `.env` file so cookies survive restarts.

First generate a random secret and copy the line it prints:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

It prints a 64-character hex string, e.g. `a1b2c3...`. Now create a file named `.env` (note: starts with a dot, no name before it) in the project root. Paste the generated secret after `COOKIE_SECRET=`. The file should look like this (replace the example secret with the one you just generated):

```ini
# .env
PORT=3000
COOKIE_SECRET=a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
BASE_URL=http://localhost:3000
```

> If you skip this step the app still runs — it will generate a throwaway secret and print a warning — but every server restart logs all guests and the admin out. For the actual wedding, do this step.

---

## 8. Create `config.js`

Create a file named `config.js` in the project root with exactly these contents. This is the single place every other file reads configuration from. It reads `.env` itself (no extra package needed — it parses the file manually), turns all the data paths into **absolute** paths, and supplies safe defaults.

**The exported keys are UPPER_SNAKE_CASE** because that is what every later section reads (`config.DATA_DIR`, `config.DB_PATH`, `config.UPLOADS_DIR`, etc.). A few lowercase aliases (`config.port`, `config.dataDir`, …) are added at the end purely for backwards compatibility — do not rely on them in new code. The badge thresholds are also defined here in the shape that `scoring.js` (section 06) imports, so there is exactly one definition of those numbers in the whole app.

```javascript
/* config.js */
// Central configuration. Every other file imports this and reads paths/keys
// from it. Nothing else in the app should hard-code a path or a port.
//
// CANONICAL CASING: every key is exported in UPPER_SNAKE_CASE because that is
// what db.js, auth.js, photos.js, export.js, admin.js and the community module
// all read. A few lowercase aliases are added at the bottom for backwards
// compatibility only.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ---- Tiny .env loader (no dependency needed) -------------------------------
// Reads KEY=VALUE lines from a .env file in the project root and copies any
// that are not already set into process.env. Lines starting with # are ignored.
function loadDotEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip optional surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

// ---- Resolve the cookie secret --------------------------------------------
// Prefer the value from the environment. If it is missing, generate a random
// one so the app still boots, and warn that sessions will reset on restart.
let cookieSecret = process.env.COOKIE_SECRET;
if (!cookieSecret || cookieSecret.trim() === '') {
  cookieSecret = crypto.randomBytes(32).toString('hex');
  console.warn(
    '[config] WARNING: COOKIE_SECRET is not set. Generated a temporary random ' +
      'secret. Guests and admin will be signed out on every restart. ' +
      'Set COOKIE_SECRET in your .env file to fix this.'
  );
}

// ---- Absolute base directories --------------------------------------------
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

// ---- The exported config object (UPPER_SNAKE_CASE = canonical) -------------
const config = {
  // Server
  PORT: parseInt(process.env.PORT, 10) || 3000,
  BASE_URL: process.env.BASE_URL || 'http://localhost:3000',
  COOKIE_SECRET: cookieSecret,

  // Project root
  ROOT: ROOT,

  // Data directories (absolute paths)
  DATA_DIR: DATA_DIR,
  DB_PATH: path.join(DATA_DIR, 'app.db'),
  UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
  THUMBS_DIR: path.join(DATA_DIR, 'thumbs'),
  EXPORTS_DIR: path.join(DATA_DIR, 'exports'),
  ADMIN_HASH_PATH: path.join(DATA_DIR, 'admin.hash'),

  // Static source directories (css / js / badges, and EJS views)
  PUBLIC_DIR: path.join(ROOT, 'src', 'public'),
  VIEWS_DIR: path.join(ROOT, 'src', 'views'),

  // Upload / image settings (used by section 05; defined here so all config
  // lives in one place)
  MAX_UPLOAD_BYTES: 12 * 1024 * 1024, // 12 MB
  THUMB_WIDTH: 400,
  ALLOWED_MIME: ['image/jpeg', 'image/png', 'image/webp'],

  // Auto-badge thresholds — THE single source of truth for these numbers.
  // scoring.js (section 06) imports BADGE_THRESHOLDS from this config instead
  // of redefining it, and guest.js (section 04) consumes the same export.
  // Shape: an ordered array of { code, n } so callers can both look a value up
  // by code and iterate thresholds in ascending order.
  BADGE_THRESHOLDS: [
    { code: 'BLOOM', n: 5 },
    { code: 'BOUQUET', n: 10 },
    { code: 'GARDEN', n: 15 },
  ],
};

// ---- Lowercase aliases (backwards compatibility ONLY) ----------------------
// New code should read the UPPER_SNAKE_CASE keys above. These aliases exist so
// any stray lowercase reference still resolves to the same value.
config.port = config.PORT;
config.baseUrl = config.BASE_URL;
config.cookieSecret = config.COOKIE_SECRET;
config.root = config.ROOT;
config.dataDir = config.DATA_DIR;
config.dbPath = config.DB_PATH;
config.uploadsDir = config.UPLOADS_DIR;
config.thumbsDir = config.THUMBS_DIR;
config.exportsDir = config.EXPORTS_DIR;
config.adminHashPath = config.ADMIN_HASH_PATH;
config.publicDir = config.PUBLIC_DIR;
config.viewsDir = config.VIEWS_DIR;
config.maxUploadBytes = config.MAX_UPLOAD_BYTES;
config.thumbWidth = config.THUMB_WIDTH;
config.allowedMime = config.ALLOWED_MIME;
config.badgeThresholds = config.BADGE_THRESHOLDS;

module.exports = config;
```

---

## 9. Create `src/app.js` (the server)

Create a file named `src/app.js` with exactly these contents. This is the complete server bootstrap for this section.

Read the inline comments — they explain each piece. The key behaviors required by the plan are all here:
- loads `config.js`
- creates `data/uploads`, `data/thumbs`, `data/exports` on boot if missing
- EJS as the view engine, views directory set to `src/views`
- `cookie-parser` initialized with the cookie secret (so cookies are signed)
- `express.urlencoded` and `express.json` body parsing
- static mounts: `/` → `src/public`, `/uploads` → `data/uploads`, `/thumbs` → `data/thumbs`
- the `attachGuest` middleware mount and the four routers (auth / guest / community / admin) mounted **only if their files exist** (they do not yet — later sections add them)
- the admin router, when present, is mounted at **`/admin`** (everything else mounts at `/`)
- a 404 handler and an error handler
- `app.listen` on the configured port, logging the local URL

> WIRING NOTE — one strategy, no double-mounting. This `app.js` uses an
> **auto-detect** approach: it mounts the middleware and each router only if its
> file already exists on disk, in a fixed order
> (`cookieParser → attachGuest → auth → admin('/admin') → guest → community → 404 → error`). The admin
> router is mounted BEFORE guest/community: guest.js gates every path under `/` with requireGuest, so if it
> ran first it would intercept `/admin` and show admins the "private link needed" page.
> Because of this, the "ADD THIS" blocks in later sections (03/04/07/08) do **not**
> need you to add `require(...)` / `app.use(...)` lines to `app.js` by hand — those
> sections simply create the router/middleware files and `app.js` picks them up on
> the next restart. If a later section's "ADD THIS" block tells you to add a require
> or app.use line to `app.js`, do NOT also keep the matching auto-detect block — pick
> one or the other so nothing mounts twice. The cleanest path is: leave `app.js` as
> written here and let later sections just drop in their files.

```javascript
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

const app = express();

// ---------------------------------------------------------------------------
// 1. Make sure the data directories exist before anything tries to use them.
// ---------------------------------------------------------------------------
function ensureDataDirs() {
  const dirs = [
    config.DATA_DIR,
    config.UPLOADS_DIR,
    config.THUMBS_DIR,
    config.EXPORTS_DIR,
  ];
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
app.use('/uploads', express.static(config.UPLOADS_DIR));
app.use('/thumbs', express.static(config.THUMBS_DIR));

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
mountRouterIfPresent('auth.js');       // section 03  -> mounts at '/'  (public links, onboarding, admin login)
mountRouterIfPresent('admin.js');      // section 08  -> mounts at '/admin'  MUST be before guest.js: guest.js
                                       //   applies requireGuest to every path under '/', which would otherwise
                                       //   intercept /admin and bounce admins to the "private link needed" page.
mountRouterIfPresent('guest.js');      // section 04  -> mounts at '/'
mountRouterIfPresent('community.js');  // section 07  -> mounts at '/'

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
app.listen(config.PORT, () => {
  console.log('');
  console.log('  Garden Party Pastels is running.');
  console.log('  Local:   http://localhost:' + config.PORT);
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

module.exports = app;
```

---

## 10. Create the 404 and error views

These two views are owned by this section (they appear under `[01-setup]` in the file tree). The full pastel theme, fonts, and shared header/footer partials arrive in section 10. To keep these pages from depending on files that do not exist yet, they include the shared partials **only if those partials are present**, and otherwise fall back to plain self-contained HTML. Do not edit `partials/head.ejs` etc. here — section 10 owns them.

Create `src/views/404.ejs`:

```html
<!-- src/views/404.ejs -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Page not found &middot; Garden Party Pastels</title>
  <style>
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #fdf7f0;
      color: #5a4a52;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 1.5rem;
    }
    .card {
      max-width: 28rem;
    }
    h1 { font-size: 3rem; margin: 0 0 0.5rem; color: #e6a4b4; }
    p { font-size: 1.1rem; line-height: 1.5; }
    a { color: #7fa8c9; }
    code {
      background: #f2e7dd;
      padding: 0.1rem 0.35rem;
      border-radius: 0.35rem;
      word-break: break-all;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Lost in the garden</h1>
    <p>We couldn't find <code><%= url %></code>.</p>
    <p><a href="/">Back to the start</a></p>
  </div>
</body>
</html>
```

Create `src/views/error.ejs`:

```html
<!-- src/views/error.ejs -->
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Something went wrong &middot; Garden Party Pastels</title>
  <style>
    body {
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      background: #fdf7f0;
      color: #5a4a52;
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      text-align: center;
      padding: 1.5rem;
    }
    .card { max-width: 28rem; }
    h1 { font-size: 2.5rem; margin: 0 0 0.5rem; color: #c98a9b; }
    p { font-size: 1.1rem; line-height: 1.5; }
    a { color: #7fa8c9; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Oh dear</h1>
    <p><%= message %></p>
    <p><a href="/">Back to the start</a></p>
  </div>
</body>
</html>
```

---

## 11. Create `scripts/set-admin-password.js`

Create a file named `scripts/set-admin-password.js` with exactly these contents. Running it hashes a password with bcryptjs and writes the hash string to `data/admin.hash`. The admin login (section 03) reads that file and compares against it. The plain password is never stored.

```javascript
// scripts/set-admin-password.js
// Hashes an admin password with bcryptjs and writes the hash to data/admin.hash.
//
// Usage (from the project root):
//   node scripts/set-admin-password.js ButtMonster
//
// To CHANGE the password later, just run it again with a new password:
//   node scripts/set-admin-password.js MyNewPassword
// It overwrites data/admin.hash. The old password stops working immediately.
//
// If you run it with no argument, it defaults to the wedding password.

const fs = require('fs');
const bcrypt = require('bcryptjs');
const config = require('../config');

// The wedding default. Override by passing a password as the first argument.
const DEFAULT_PASSWORD = 'ButtMonster';

const password = process.argv[2] || DEFAULT_PASSWORD;

// Make sure the data directory exists (it may not on a fresh checkout).
if (!fs.existsSync(config.DATA_DIR)) {
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

// bcryptjs is synchronous-capable. 10 salt rounds is the agreed cost.
const hash = bcrypt.hashSync(password, 10);

fs.writeFileSync(config.ADMIN_HASH_PATH, hash, 'utf8');

console.log('Admin password set.');
console.log('Hash written to:', config.ADMIN_HASH_PATH);
if (password === DEFAULT_PASSWORD) {
  console.log('(Used the default wedding password.)');
}
```

---

## 12. Set the admin password

From the project root:

```powershell
node scripts/set-admin-password.js ButtMonster
```

Expected output:

```
Admin password set.
Hash written to: ...\garden-party-pastels\data\admin.hash
(Used the default wedding password.)
```

This also creates the `data` folder if it did not exist. The file `data/admin.hash` now contains a single line like `$2a$10$....` — that is the hash, not the password.

To change the password later, run the same command with a different word, e.g. `node scripts/set-admin-password.js SomethingElse`. It overwrites the file.

---

## 13. Start the app

From the project root:

```powershell
npm start
```

Expected output (the temporary home line and skipped-router lines are normal at this stage):

```
[app] created directory: ...\data\uploads
[app] created directory: ...\data\thumbs
[app] created directory: ...\data\exports
[app] router not present yet (skipped): auth.js
[app] router not present yet (skipped): guest.js
[app] router not present yet (skipped): community.js
[app] router not present yet (skipped): admin.js

  Garden Party Pastels is running.
  Local:   http://localhost:3000
  Press Ctrl+C to stop.
```

Open a browser to <http://localhost:3000>. You should see the plain text line: *"Garden Party Pastels server is running. ..."*. Visit <http://localhost:3000/nope> and you should see the pastel "Lost in the garden" 404 page.

Leave this PowerShell window open and running. To stop the server, click the window and press `Ctrl+C`.

> The order for a full, real run later is: `npm install` (step 4) → `node scripts/set-admin-password.js ButtMonster` (step 12) → `node scripts/seed.js` (added in section 02) → `npm start` (step 13). The seed step is skipped in this section because `scripts/seed.js` does not exist yet.

---

## 14. Going live: the free Cloudflare quick tunnel

The laptop serves plain HTTP on port 3000, reachable only on the local network. To let guests reach it from anywhere (phones on cell data), we put a free Cloudflare "quick tunnel" in front. It needs **no account and no login** and gives you a public `https://something.trycloudflare.com` address that forwards to your laptop.

### 14a. Install cloudflared (one time)

The simplest install on Windows is via `winget` (built into Windows 11):

```powershell
winget install --id Cloudflare.cloudflared
```

Accept any source/agreement prompts. After it finishes, **close and reopen PowerShell** so the new program is on PATH, then verify:

```powershell
cloudflared --version
```

Expected: it prints a version line like `cloudflared version 2024.x.x ...`.

If `winget` is unavailable or blocked, download the Windows executable manually from <https://github.com/cloudflare/cloudflared/releases> (file named `cloudflared-windows-amd64.exe`), rename it to `cloudflared.exe`, put it in your project root, and in step 14b run `.\cloudflared.exe tunnel --url http://localhost:3000` instead of `cloudflared tunnel ...`.

### 14b. Open the tunnel

The app must already be running (step 13) in its own PowerShell window. Open a **second** PowerShell window and run:

```powershell
cloudflared tunnel --url http://localhost:3000
```

It prints a box in the output containing your public URL. Look for a line like:

```
+--------------------------------------------------------------------------------------------+
|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):   |
|  https://random-words-here.trycloudflare.com                                                |
+--------------------------------------------------------------------------------------------+
```

That `https://....trycloudflare.com` address is the public link. Open it on your phone to confirm it shows the same page as `http://localhost:3000`.

Important notes:
- Keep this second window open the whole time. Closing it (or pressing `Ctrl+C`) kills the public link.
- The URL is **random and changes every time you restart the tunnel.** Generate the guest QR codes (section 08) only after the tunnel is up and running for the event, or rely on the local URL per the plan's `BASE_URL` default. Do not restart the tunnel during the reception or all printed/shared links break.
- It can take 10–30 seconds after startup before the URL responds. Give it a moment before deciding it's broken.

---

## 15. Keep the laptop awake (do this before the reception)

If the laptop sleeps mid-reception, both the server and the tunnel die. Disable sleep while plugged in.

### 15a. The quick way (PowerShell, plugged in / "AC")

Open PowerShell **as Administrator** (right-click PowerShell → "Run as administrator") and run these two lines. They set the standby and display timeouts to 0 (= never) while on wall power:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change monitor-timeout-ac 0
```

There is no visible confirmation; that is normal. To confirm it took, run `powercfg /query` — but you can trust it if no error appeared.

### 15b. The Settings-app way (alternative / double-check)

1. Press `Win + I` to open Settings.
2. Go to **System → Power & battery → Screen and sleep** (on some builds: **Power & sleep**).
3. Set **When plugged in, turn off my screen after** to **Never**.
4. Set **When plugged in, put my device to sleep after** to **Never**.

### 15c. Also handle the lid

If the couple will close the laptop lid, set "closing the lid does nothing" while plugged in:

1. Press `Win + R`, type `control powercfg.cpl`, press Enter.
2. Click **Choose what closing the lid does** (left side).
3. For **When I close the lid → Plugged in**, choose **Do nothing**.
4. Click **Save changes**.

Keep the laptop plugged into wall power for the whole event.

---

## 16. Backups (copy the data folder while running)

Everything the app stores lives in the `data/` folder: `app.db` (the database), `uploads/` (full-size photos + avatars), `thumbs/` (thumbnails), `admin.hash`, and `exports/`. Copying that one folder is a complete backup. `better-sqlite3` is safe to copy while running for an occasional backup like this; for the wedding's traffic this is fine.

To make a timestamped backup copy from PowerShell (run from the project root):

```powershell
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Copy-Item -Path .\data -Destination "..\gpp-backup-$stamp" -Recurse
```

This creates a sibling folder next to the project, e.g. `..\gpp-backup-20260627-153000`, containing a full copy. Do this once before the event, once or twice during, and once right after.

To restore from a backup: stop the server (`Ctrl+C`), delete or rename the current `data` folder, copy a backup folder back to `.\data`, then `npm start` again.

> The cleanest backup is taken with the server stopped (press `Ctrl+C` first, copy, then `npm start`). During the reception, a live copy as shown above is acceptable and avoids downtime.

---

## Acceptance check

Do these in order. Each has an exact expected result.

1. **Node version.** Run `node --version`. Expect output starting with `v20.`.

2. **Install succeeded.** From the project root run `npm install`. Expect it to finish with no `npm ERR!` lines, and a `node_modules` folder now exists. Confirm key packages are present:
   ```powershell
   Test-Path .\node_modules\express
   Test-Path .\node_modules\better-sqlite3
   Test-Path .\node_modules\sharp
   ```
   Each prints `True`.

3. **Admin hash written.** Run `node scripts/set-admin-password.js ButtMonster`. Expect "Admin password set." Then:
   ```powershell
   Test-Path .\data\admin.hash
   ```
   Prints `True`, and the file's contents start with `$2a$` (a bcrypt hash). Confirm:
   ```powershell
   (Get-Content .\data\admin.hash).StartsWith('$2a$')
   ```
   Prints `True`.

4. **Server boots and creates data dirs.** Run `npm start`. Expect the startup banner ending with `Local: http://localhost:3000`, and the three "created directory" lines (or, on a second run, no errors). Confirm the folders exist (in a second PowerShell window, or after stopping):
   ```powershell
   Test-Path .\data\uploads
   Test-Path .\data\thumbs
   Test-Path .\data\exports
   ```
   Each prints `True`.

5. **Home page responds.** With the server running, open <http://localhost:3000> in a browser. Expect the plain text "Garden Party Pastels server is running. ..." message (HTTP 200).

6. **404 page works.** Open <http://localhost:3000/does-not-exist>. Expect the pastel "Lost in the garden" page showing the path you typed, returned as HTTP 404.

7. **Cookie secret is fixed.** Confirm `.env` exists and `COOKIE_SECRET` has a value:
   ```powershell
   Test-Path .\.env
   ```
   Prints `True`. When you ran `npm start` you should NOT have seen the `WARNING: COOKIE_SECRET is not set` line. If you did, your `.env` is missing or `COOKIE_SECRET` is blank — fix step 7.

8. **Public tunnel (only test when you intend to go live).** With the server running, in a second window run `cloudflared tunnel --url http://localhost:3000`. Within ~30 seconds it prints a `https://….trycloudflare.com` URL. Open that URL on your phone and confirm it shows the same home page. Press `Ctrl+C` in that window to close the tunnel when done testing.

If all eight pass, section 01 is complete and the foundation is ready for section 02 (database).
