# 03 — Auth and Links: Guest Sign-In, Sessions, QR Codes, Admin Login

This section builds the entire sign-in system. There are no passwords for guests. Each guest has a secret link printed as a QR code on their place-card; scanning it signs them in on their phone and keeps them signed in. The admin (the couple) uses one password to get into the control panel.

When you finish this section the app will be able to: turn a guest link into a QR code image, recognize a returning guest from a cookie, send first-time guests through an onboarding form (name, avatar, social links), and let the admin log in and out.

> **PREREQUISITE — create the shared partials first.** The two views in this section (`onboard.ejs`, `admin-login.ejs`) use `<%- include('partials/head') %>`, `header`, and `footer`. EJS's `include()` throws `ENOENT` ("Could not find include file") and returns an HTTP 500 if the partial file does not exist — it does **not** silently skip a missing include. So before you run this section's acceptance check you **must** create the three partials (`src/views/partials/head.ejs`, `header.ejs`, `footer.ejs`) from **section 10, steps 2–4**. Do that now. (If you already created them in section 10, skip this.) Without them, rendering `/onboard` and `/admin/login` will 500.

## What you are building (file checklist)

You will create exactly these five files:

1. `src/services/qr.js` — turns a URL into a QR-code PNG image (used later by the printable QR sheet).
2. `src/middleware/session.js` — the three "gatekeeper" functions: `attachGuest`, `requireGuest`, `requireAdmin`.
3. `src/routes/auth.js` — the routes: consume a guest link, onboarding, admin login/logout.
4. `src/views/onboard.ejs` — the first-time guest form.
5. `src/views/admin-login.ejs` — the admin password form.

You do **not** edit `src/app.js` or `.env.example` in this section. See "Step 6 — How the auth router gets wired in" below: section 01's `app.js` auto-discovers and mounts `src/middleware/session.js` and `src/routes/auth.js` for you. The only thing you may need to touch is confirming the `BASE_URL` line exists in `.env.example` (Step 7).

## Plain-English explanation of the cookie security

A **cookie** is a small piece of text the browser stores and sends back to our server on every request. We use it to remember who someone is so they do not have to scan their QR code again on every page.

We use two cookies:

- `gsid` — holds the guest's secret token (the same random string that is in their link). This is how we know which guest is using the phone.
- `admin` — holds the value `"1"`. Its mere presence (signed, see below) means "this browser has logged in as the admin."

Two protections are applied to both cookies:

- **Signed.** When we set a cookie we attach a cryptographic signature using a secret key (`COOKIE_SECRET`). When the cookie comes back, `cookie-parser` checks the signature. If anyone edited the cookie value in their browser, the signature no longer matches and the server ignores it. This stops a guest from typing in someone else's token by hand or flipping `admin` to `"1"` themselves. (It does not *encrypt* the value — a curious person can still read their own token — it just makes the value **tamper-proof**.)
- **httpOnly.** The cookie cannot be read by JavaScript running in the page. This blocks a whole class of attacks where malicious script tries to steal the cookie.

We also set `sameSite: 'lax'` (the cookie is sent on normal navigations but not on sketchy cross-site form posts) and `secure: false`. `secure: false` is deliberate: our laptop serves plain `http` on port 3000, and the Cloudflare tunnel is what adds the padlock/`https` for the outside world. If we set `secure: true`, the cookie would be dropped on the laptop's own `http` connection and nothing would work.

## How BASE_URL makes links work locally AND through the tunnel

A guest's link looks like `<BASE_URL>/j/<token>` — for example `https://random-words.trycloudflare.com/j/ab12...`. The QR code must contain the **public** address that guests' phones can reach, not `localhost` (a phone cannot reach the laptop's `localhost`).

`config.js` (built in section 01) reads `BASE_URL` and defaults it to `http://localhost:3000`. On the wedding weekend you will set `BASE_URL` to the `https://....trycloudflare.com` address that `cloudflared` prints, so every generated QR points at the public tunnel. The QR service in this section does **not** hard-code any address — it just renders whatever full URL it is handed. Building the full URL from `BASE_URL` happens in the admin QR sheet (section 08); this section only provides the rendering helper.

## How the onboarding gate works (and why we use an `onboarded` flag, not the name)

A guest goes through onboarding **once**. The trigger for "show this guest onboarding" is a dedicated database column, `onboarded` (an integer `0`/`1`), defined on the `guests` table in **section 02** — **not** whether the guest's `name` is blank.

This matters because the admin can pre-name guests. Section 08's bulk-add and named-add flows create guest rows that already have a `name` set. If the onboarding trigger were "name is empty," those pre-named guests would skip onboarding entirely and never get the chance to add an avatar or social links — they would land straight on the home page with no way to capture that info except by hunting for `/me/edit` themselves.

By gating on the `onboarded` flag instead, a pre-named guest still sees the onboarding form (their name is pre-filled, which is friendly), can add an avatar and socials, and the flag is flipped to `1` when they submit. After that they go straight home on every future scan.

> **Dependency on section 02:** this requires the `guests` table to have `onboarded INTEGER NOT NULL DEFAULT 0`. Section 02's schema includes it. If you built section 02 before this rule was added, add the column: `ALTER TABLE guests ADD COLUMN onboarded INTEGER NOT NULL DEFAULT 0;` and treat existing rows appropriately.

---

## Build steps

### Step 1 — Create `src/services/qr.js`

This wraps the `qrcode` package (version 1.5.4, already installed in section 01). It exposes one function, `qrDataUrl(url)`, which returns a Promise of a PNG **data URL** — a string starting with `data:image/png;base64,...` that you can drop straight into an `<img src="...">` with no separate image file needed.

Create the file `src/services/qr.js` with exactly this content:

```js
// src/services/qr.js
'use strict';

const QRCode = require('qrcode');

/**
 * Turn a full URL into a PNG "data URL" suitable for an <img src="...">.
 * The returned string looks like: data:image/png;base64,iVBORw0KGgo...
 *
 * @param {string} url  The full link to encode, e.g. https://x.trycloudflare.com/j/<token>
 * @returns {Promise<string>} a data URL string
 */
async function qrDataUrl(url) {
  if (typeof url !== 'string' || url.length === 0) {
    throw new Error('qrDataUrl requires a non-empty URL string');
  }
  // margin:1 keeps the white border small; width:240 prints cleanly on a place-card.
  // errorCorrectionLevel 'M' tolerates a little print smudging while staying scannable.
  return QRCode.toDataURL(url, {
    margin: 1,
    width: 240,
    errorCorrectionLevel: 'M'
  });
}

module.exports = { qrDataUrl };
```

### Step 2 — Create `src/middleware/session.js`

These three functions run on requests:

- `attachGuest` runs on **every** request. It reads the signed `gsid` cookie, looks up the matching guest in the database, and stashes the guest object on `req.guest` (and `res.locals.guest` so views can use it). If there is no valid cookie or no matching guest, both are set to `null`.
- `requireGuest` is placed in front of guest-only routes. If there is no guest, it shows a friendly "ask the couple for your link" page instead of letting them through.
- `requireAdmin` is placed in front of admin routes. If the signed `admin` cookie is not exactly `"1"`, it redirects to `/admin/login`.

Create the file `src/middleware/session.js` with exactly this content:

```js
// src/middleware/session.js
'use strict';

const { db } = require('../db');

/**
 * Runs on every request. Reads the signed `gsid` cookie (the guest's token),
 * loads that guest row from the database, and attaches it to req.guest and
 * res.locals.guest. Sets both to null if there is no valid guest.
 */
function attachGuest(req, res, next) {
  let guest = null;
  // req.signedCookies is populated by cookie-parser(COOKIE_SECRET).
  // If the signature is invalid (tampered cookie), cookie-parser sets the
  // value to `false`, so we guard against anything that is not a real string.
  const token = req.signedCookies && req.signedCookies.gsid;
  if (typeof token === 'string' && token.length > 0) {
    guest = db.prepare('SELECT * FROM guests WHERE token = ?').get(token) || null;
  }
  req.guest = guest;
  res.locals.guest = guest;

  // One-shot flash: read the signed `flash` cookie into res.locals.flash and
  // clear it so the message shows exactly once. Shape is { type, msg } — the
  // canonical flash shape written by guest.js (section 04) and read by
  // header.ejs (section 10).
  let flash = null;
  const rawFlash = req.signedCookies && req.signedCookies.flash;
  if (typeof rawFlash === 'string' && rawFlash.length > 0) {
    try {
      const parsed = JSON.parse(rawFlash);
      if (parsed && typeof parsed === 'object') flash = parsed;
    } catch (e) {
      flash = null;
    }
    res.clearCookie('flash', { path: '/' });
  }
  res.locals.flash = flash;

  next();
}

/**
 * Gate for guest-only pages. If no guest is attached, show a friendly
 * "ask the couple for your link" page instead of the requested page.
 * Assumes attachGuest already ran earlier in the chain.
 */
function requireGuest(req, res, next) {
  if (req.guest) {
    return next();
  }
  res.status(403).type('html').send(linkRequiredPage());
  return undefined;
}

/**
 * Gate for admin-only pages. The signed `admin` cookie must equal "1".
 * Otherwise send the visitor to the admin login form.
 */
function requireAdmin(req, res, next) {
  const flag = req.signedCookies && req.signedCookies.admin;
  if (flag === '1') {
    return next();
  }
  res.redirect('/admin/login');
  return undefined;
}

/**
 * Small self-contained themed HTML page shown when a non-signed-in visitor
 * tries to reach a guest page. Inline (not an EJS view) so this section has
 * no dependency on views owned by other sections.
 */
function linkRequiredPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your private link is needed</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600&family=Dancing+Script:wght@600&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#fff8f0;color:#5b5552;font-family:'Quicksand',sans-serif;padding:24px;}
  .card{background:#ffffff;border:1px solid #f3e3df;border-radius:18px;max-width:380px;
        width:100%;padding:28px 24px;text-align:center;box-shadow:0 8px 24px rgba(214,180,180,.18);}
  h1{font-family:'Dancing Script',cursive;color:#e7a6b6;font-size:2rem;margin:.2em 0 .4em;}
  p{line-height:1.5;margin:.5em 0;}
  .hint{font-size:.9rem;color:#8a8380;}
</style>
</head>
<body>
  <div class="card">
    <h1>Almost there!</h1>
    <p>This page is just for guests who have signed in with their own private link.</p>
    <p>Find your <strong>place-card QR code</strong> at your table and scan it with your phone's camera, or ask Axel &amp; Lily for your link.</p>
    <p class="hint">Once you scan it, you'll stay signed in on this phone.</p>
  </div>
</body>
</html>`;
}

module.exports = { attachGuest, requireGuest, requireAdmin };
```

### Step 3 — Create `src/routes/auth.js`

> **Reminder:** the two views this router renders (`onboard`, `admin-login`) include the section-10 partials. Make sure you created `head.ejs`, `header.ejs`, and `footer.ejs` (section 10 steps 2–4) before testing, or these renders will 500. See the prerequisite note at the top of this file.

This router handles five route groups:

- `GET /j/:token` — the link/QR target. Look up the guest by token. If found, set the signed `gsid` cookie and redirect: to `/onboard` if they have **not finished onboarding yet** (the `onboarded` flag is `0`), otherwise to `/`. If the token is unknown, show the same friendly "link needed" message.
- `GET /onboard` and `POST /onboard` — the first-time form (name, optional avatar photo, optional social links). `requireGuest` protects both. The name input is pre-filled with whatever name the admin may have already set, and submitting the form sets `onboarded = 1`.
- `GET /admin/login` and `POST /admin/login` — render the password form and check the password against the bcrypt hash in `data/admin.hash`.
- `POST /admin/logout` — clear the admin cookie.

The avatar upload uses `multer` (memory storage) for the single `avatar` field. Saving the avatar to disk is the job of the **photos service** (`src/services/photos.js`), which is built later in section 05. To keep this section runnable on its own, we load that service lazily and skip the avatar gracefully if it is not present yet — the rest of onboarding (name, socials) always works.

> **About the post-login redirect (`/admin`).** On a successful admin login this router does `res.redirect('/admin')`. The page at `/admin` is the dashboard built in **section 08**, and it only resolves once section 08's admin router is mounted **at the path `/admin`** (see Step 6 below for how mounting works and the one path everyone agrees on). Until section 08 is built, logging in will land on a 404 at `/admin` — that is expected and acceptable for this section; the acceptance check below verifies the redirect target and the `admin` cookie, not the destination page. Do not "fix" this by redirecting somewhere else.

Create the file `src/routes/auth.js` with exactly this content:

```js
// src/routes/auth.js
'use strict';

const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');
const multer = require('multer');

const config = require('../../config');
const { db } = require('../db');
const { requireGuest } = require('../middleware/session');

const router = express.Router();

// 14 days in milliseconds — how long a guest/admin stays signed in.
const COOKIE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Shared cookie options. secure:false because the laptop serves plain http;
// Cloudflare adds https on the outside. signed:true makes the value tamper-proof.
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: 'lax',
  secure: false,
  signed: true,
  maxAge: COOKIE_MAX_AGE_MS,
  path: '/'
};

// Avatar upload: keep the file in memory so the photos service (section 05)
// can process the buffer; only one file, field name "avatar".
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 }
});

/**
 * Build a clean JSON string from the three optional social fields.
 * Empty fields are dropped so we never store blank values.
 */
function buildSocialLinks(body) {
  const out = {};
  const instagram = (body.instagram || '').trim();
  const facebook = (body.facebook || '').trim();
  const website = (body.website || '').trim();
  if (instagram) out.instagram = instagram;
  if (facebook) out.facebook = facebook;
  if (website) out.website = website;
  return JSON.stringify(out);
}

/**
 * Try to save the avatar buffer via the photos service. Returns the relative
 * filename to store in guests.avatar_path, or null if no file / service not
 * available yet. This keeps section 03 runnable before section 05 exists.
 */
async function trySaveAvatar(file, guestId) {
  if (!file || !file.buffer || file.buffer.length === 0) {
    return null;
  }
  let photos;
  try {
    photos = require('../services/photos');
  } catch (err) {
    // photos.js not created yet (section 05). Skip the avatar for now.
    return null;
  }
  if (!photos || typeof photos.saveAvatar !== 'function') {
    return null;
  }
  // photos.saveAvatar(buffer, guestId) is ASYNC (sharp returns a Promise). It
  // writes the avatar file, sets guests.avatar_path, and resolves to the
  // relative filename. Await it.
  return await photos.saveAvatar(file.buffer, guestId);
}

// --- Guest link / QR target -------------------------------------------------

// GET /j/:token  — consume a guest's private link, sign them in.
router.get('/j/:token', (req, res) => {
  const token = req.params.token;
  const guest = db.prepare('SELECT * FROM guests WHERE token = ?').get(token);
  if (!guest) {
    // Unknown token: do not sign anyone in; show the friendly message.
    res.status(404).type('html').send(unknownLinkPage());
    return;
  }
  res.cookie('gsid', guest.token, COOKIE_OPTS);
  // Anyone who has not finished onboarding goes to the form; everyone else
  // goes home. We key on the `onboarded` flag (not name-emptiness) so that
  // guests the admin pre-named still get to add an avatar and social links.
  if (!guest.onboarded) {
    res.redirect('/onboard');
  } else {
    res.redirect('/');
  }
});

// --- Onboarding -------------------------------------------------------------

// GET /onboard — show the first-time form (name / avatar / socials).
// Pre-fill the name with whatever the admin may already have set.
router.get('/onboard', requireGuest, (req, res) => {
  res.render('onboard', {
    title: 'Welcome',
    error: null,
    guest: req.guest
  });
});

// POST /onboard — save the guest's name, optional avatar, optional socials,
// and mark them onboarded so they never see this form again.
router.post('/onboard', requireGuest, upload.single('avatar'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) {
    res.status(400).render('onboard', {
      title: 'Welcome',
      error: 'Please tell us your name so it can appear on the leaderboard.',
      guest: req.guest
    });
    return;
  }

  const socialLinks = buildSocialLinks(req.body);
  const avatarPath = await trySaveAvatar(req.file, req.guest.id); // null if no file / service

  if (avatarPath) {
    db.prepare('UPDATE guests SET name = ?, social_links = ?, avatar_path = ?, onboarded = 1 WHERE id = ?')
      .run(name, socialLinks, avatarPath, req.guest.id);
  } else {
    db.prepare('UPDATE guests SET name = ?, social_links = ?, onboarded = 1 WHERE id = ?')
      .run(name, socialLinks, req.guest.id);
  }

  res.redirect('/');
});

// --- Admin login / logout ---------------------------------------------------

// GET /admin/login — show the password form.
router.get('/admin/login', (req, res) => {
  res.render('admin-login', { title: 'Admin Login', error: null });
});

// POST /admin/login — check password against the bcrypt hash on disk.
// Note: app.js (section 01) already parses urlencoded bodies globally, so we
// do NOT add an inline body parser here — req.body.password is already populated.
router.post('/admin/login', (req, res) => {
  const password = req.body.password || '';

  let hash;
  try {
    hash = fs.readFileSync(config.ADMIN_HASH_PATH, 'utf8').trim();
  } catch (err) {
    res.status(500).render('admin-login', {
      title: 'Admin Login',
      error: 'Admin password is not set up yet. Run: node scripts/set-admin-password.js ButtMonster'
    });
    return;
  }

  const ok = bcrypt.compareSync(password, hash);
  if (!ok) {
    res.status(401).render('admin-login', {
      title: 'Admin Login',
      error: 'Incorrect password. Please try again.'
    });
    return;
  }

  res.cookie('admin', '1', COOKIE_OPTS);
  // Lands on the section-08 admin dashboard, which must be mounted at /admin.
  // Until section 08 exists this 404s, which is fine for section 03.
  res.redirect('/admin');
});

// POST /admin/logout — clear the admin cookie.
router.post('/admin/logout', (req, res) => {
  res.clearCookie('admin', { path: '/' });
  res.redirect('/admin/login');
});

// --- Inline page for an unknown/expired token -------------------------------

function unknownLinkPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Link not recognized</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Quicksand:wght@400;600&family=Dancing+Script:wght@600&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#fff8f0;color:#5b5552;font-family:'Quicksand',sans-serif;padding:24px;}
  .card{background:#ffffff;border:1px solid #f3e3df;border-radius:18px;max-width:380px;
        width:100%;padding:28px 24px;text-align:center;box-shadow:0 8px 24px rgba(214,180,180,.18);}
  h1{font-family:'Dancing Script',cursive;color:#e7a6b6;font-size:2rem;margin:.2em 0 .4em;}
  p{line-height:1.5;margin:.5em 0;}
</style>
</head>
<body>
  <div class="card">
    <h1>Hmm, that link didn't work</h1>
    <p>We couldn't find that private link. Double-check you scanned the QR code on your own place-card, or ask Axel &amp; Lily for help.</p>
  </div>
</body>
</html>`;
}

module.exports = router;
```

### Step 4 — Create `src/views/onboard.ejs`

> **Reminder:** this view includes `partials/head`, `partials/header`, and `partials/footer`. Those files come from **section 10 (steps 2–4)** and must exist before you render this page, or EJS `include()` will throw and the page will 500. Create them first if you have not.

This is the first-time guest form. It uses the shared partials (`head`, `header`, `footer`) that are authored in section 10. Those partials open the page, load `theme.css` and Google Fonts, and close the page — so this view only contains the middle content. The name field is pre-filled with `guest.name` (which may be blank, or may be a name the admin pre-set). The form posts to `/onboard` as `multipart/form-data` (required because it can carry the avatar file).

Create the file `src/views/onboard.ejs` with exactly this content:

```html
<!-- src/views/onboard.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="page page--narrow">
  <h1 class="display-title">Welcome to the party!</h1>
  <p class="lead">Let's set up your profile. Only your name is required — everything else is optional and you can change it later.</p>

  <% if (error) { %>
    <div class="alert alert--error"><%= error %></div>
  <% } %>

  <form class="form" action="/onboard" method="POST" enctype="multipart/form-data">
    <div class="form-row">
      <label class="form-label" for="name">Your name <span class="req">*</span></label>
      <input class="form-input" type="text" id="name" name="name" maxlength="60"
             required autocomplete="name" placeholder="e.g. Casey Rivera"
             value="<%= (guest && guest.name) ? guest.name : '' %>">
      <p class="form-help">This is what shows on the leaderboard and your profile.</p>
    </div>

    <div class="form-row">
      <label class="form-label" for="avatar">Profile photo (optional)</label>
      <input class="form-input" type="file" id="avatar" name="avatar"
             accept="image/jpeg,image/png,image/webp">
      <p class="form-help">A selfie or any picture of you. You can add or change this later.</p>
    </div>

    <fieldset class="form-fieldset">
      <legend class="form-legend">Social links (optional)</legend>
      <p class="form-help">Add these if you'd like other guests to be able to connect with you.</p>

      <div class="form-row">
        <label class="form-label" for="instagram">Instagram</label>
        <input class="form-input" type="text" id="instagram" name="instagram"
               maxlength="120" placeholder="@yourhandle or full link">
      </div>

      <div class="form-row">
        <label class="form-label" for="facebook">Facebook</label>
        <input class="form-input" type="text" id="facebook" name="facebook"
               maxlength="200" placeholder="facebook.com/you">
      </div>

      <div class="form-row">
        <label class="form-label" for="website">Website</label>
        <input class="form-input" type="text" id="website" name="website"
               maxlength="200" placeholder="https://...">
      </div>
    </fieldset>

    <button class="btn btn--primary" type="submit">Start the hunt</button>
  </form>
</main>

<%- include('partials/footer') %>
```

### Step 5 — Create `src/views/admin-login.ejs`

> **Reminder:** same partial dependency as above — `head`/`header`/`footer` from section 10 must exist before this renders.

The admin password form. Same partial convention. It posts to `/admin/login`.

Create the file `src/views/admin-login.ejs` with exactly this content:

```html
<!-- src/views/admin-login.ejs -->
<%- include('partials/head') %>
<%- include('partials/header') %>

<main class="page page--narrow">
  <h1 class="display-title">Task Master Login</h1>
  <p class="lead">Enter the admin password to manage tasks, guests, and points.</p>

  <% if (error) { %>
    <div class="alert alert--error"><%= error %></div>
  <% } %>

  <form class="form" action="/admin/login" method="POST" autocomplete="off">
    <div class="form-row">
      <label class="form-label" for="password">Password</label>
      <input class="form-input" type="password" id="password" name="password"
             required autofocus>
    </div>
    <button class="btn btn--primary" type="submit">Log in</button>
  </form>
</main>

<%- include('partials/footer') %>
```

### Step 6 — How the auth router gets wired in (no manual edit needed)

You do **not** need to edit `src/app.js` for this section. Section 01's `app.js` is built to **auto-discover** the files you just created:

- It checks for `src/middleware/session.js`. Once that file exists (it does now), `app.js` automatically mounts `attachGuest` so it runs on every request, and stops using the no-op fallback it used before session.js existed.
- It checks for `src/routes/auth.js`. Once that file exists, its `mountRouterIfPresent` helper automatically mounts the auth router at the root (`/`), which is correct because auth defines absolute paths (`/j/:token`, `/onboard`, `/admin/login`, `/admin/logout`).

**Do NOT add `app.use(attachGuest)` or `app.use('/', authRouter)` by hand.** Section 01's `app.js` already does both as soon as the files exist. Adding them again would mount `attachGuest` twice (harmless but confusing) and is unnecessary. If a previous version of this section told you to paste an "ADD THIS to `src/app.js`" block, **skip it** — that block is redundant with section 01's auto-discovery and only invites double-mounting.

#### One important mount-path agreement (read this so section 08 lands correctly)

Section 01's `mountRouterIfPresent` mounts most routers at the root path `/`. That is correct for `auth.js` and the guest/community routers, whose routes are written as absolute paths. It is **NOT** correct for the **admin** router (`src/routes/admin.js`, section 08), whose routes are written **relative to `/admin`** — for example `router.get('/')` is meant to be the dashboard at `GET /admin`, and `router.get('/guests')` is meant to be `GET /admin/guests`.

If the admin router were mounted at `/` like the others, the dashboard would collide with the guest home page at `GET /` and `/guests` would be the wrong URL. So there must be exactly **one** rule, and both section 01 and section 08 must agree on it:

> **The admin router is mounted once, at `/admin`.** Section 01's `app.js` special-cases `src/routes/admin.js`: instead of mounting it at `/` via the generic `mountRouterIfPresent`, it mounts it with `app.use('/admin', require('./routes/admin'))`, and it does this **after** the auth router is mounted (so that the public `/admin/login` route in `auth.js` is matched before the admin router's `requireAdmin` guard). Because section 01 already does this, **section 08 should NOT add its own `app.use('/admin', require('./routes/admin'))`** — doing so would mount the admin router a second time and create duplicate routes (e.g. both `/guests` and `/admin/guests`). Pick the section-01 auto-mount as the single source of truth; section 08 only authors `admin.js`, it does not mount it.

This is the agreement that makes the post-login `res.redirect('/admin')` in `auth.js` resolve to the real dashboard once section 08 exists.

### Step 7 — Confirm BASE_URL in the example env file

`.env.example` is owned by section 01 and should already document `BASE_URL`. You do not normally need to touch it. Just confirm the line exists; if for some reason it is missing, add it.

**Only if missing, add this to `.env.example`:**

```bash
# .env.example  — (section 01 should already contain this)
# Public base address used to build guest links inside the printed QR codes.
# Local testing: leave as the default below.
# Wedding day: set this to the https://....trycloudflare.com address that
# `cloudflared tunnel --url http://localhost:3000` prints, so the QR codes
# point at the public tunnel instead of localhost.
BASE_URL=http://localhost:3000
```

---

## Acceptance check

Do all commands from the project root in PowerShell. Sections 01 and 02 must already be done (so `npm install` has run, `config.js`, `db.js`, and `data/app.db` exist, and the `guests` table has the `onboarded` column). **You must also have created the three partials from section 10 steps 2–4** (`src/views/partials/head.ejs`, `header.ejs`, `footer.ejs`) — without them the `/onboard` and `/admin/login` renders will 500, because EJS `include()` errors on a missing partial. The photos service (section 05) does **not** need to exist yet — the avatar field will simply be skipped.

### A. Set the admin password and start the app

```powershell
node scripts/set-admin-password.js ButtMonster
node scripts/seed.js
npm start
```

Leave the app running. It should print that it is listening on port 3000. Open a second PowerShell window for the test commands below, or use a browser.

### B. Create a test guest token directly in the database

We need a real token to test the link. Insert one test guest and read its token back:

```powershell
node -e "const {db}=require('./src/db'); const t=require('crypto').randomBytes(16).toString('hex'); db.prepare('INSERT INTO guests (token) VALUES (?)').run(t); console.log(t)"
```

Copy the 32-character token it prints. (The new row has `onboarded = 0` by default, which is what makes it route to the onboarding form.)

### C. Test the guest link, the cookie, and onboarding (browser)

1. In a browser, visit `http://localhost:3000/j/<paste-the-token-here>`.
   - **Expected:** you are redirected to `http://localhost:3000/onboard` and see the "Welcome to the party!" form. (Because the new guest has not been onboarded yet.)
   - In the browser dev tools (F12) under Application > Cookies, you should see a `gsid` cookie marked **HttpOnly**.
2. Submit the form with a name like `Test Guest`, leave the avatar empty, optionally add an Instagram value.
   - **Expected:** you are redirected to `/` (the guest home page — built in section 04; until then you may see that route's placeholder or a 404 for `/`, which is fine for this section's purposes; the redirect itself is the thing being verified).
3. Visit `http://localhost:3000/j/<same-token>` again.
   - **Expected:** this time you are redirected to `/` (not `/onboard`), because the guest is now marked onboarded.

Confirm the data was saved:

```powershell
node -e "const {db}=require('./src/db'); console.log(db.prepare('SELECT id,name,social_links,avatar_path,onboarded FROM guests ORDER BY id DESC LIMIT 1').get())"
```

- **Expected:** the row shows your name, `social_links` as a JSON string (e.g. `{\"instagram\":\"...\"}` or `{}`), `avatar_path` as `null` (since section 05 is not built yet), and `onboarded` as `1`.

### D. Test an unknown token

Visit `http://localhost:3000/j/not-a-real-token`.

- **Expected:** an HTTP 404 page titled "Hmm, that link didn't work" with the pastel card styling. No cookie is set.

### E. Test the guest gate

Open a **private/incognito** window (so it has no `gsid` cookie) and visit `http://localhost:3000/onboard`.

- **Expected:** an HTTP 403 friendly page "Almost there!" telling them to scan their place-card QR. They are not allowed into onboarding without a link.

### F. Test admin login, the admin gate, and logout

1. In the incognito window, visit `http://localhost:3000/admin`.
   - **Expected:** redirected to `http://localhost:3000/admin/login` (the gate blocks you). Note: this only works once section 08's admin router is mounted at `/admin` per Step 6. If section 08 is not built yet, `/admin` will simply 404 (there is no route there to guard) — that is acceptable for this section; the login/cookie behavior in the remaining steps is what's being verified.
2. On the login form, type the **wrong** password and submit.
   - **Expected:** the page reloads showing "Incorrect password." and you are still on `/admin/login`.
3. Type the correct password `ButtMonster` and submit.
   - **Expected:** redirected to `/admin` (the dashboard route is built in section 08 and mounted at `/admin` per Step 6; until then a placeholder/404 at `/admin` is acceptable — the successful redirect and the `admin` cookie are what matter). In dev tools you should now see a signed, HttpOnly `admin` cookie.
4. Confirm the signed cookie is tamper-proof: in dev tools, edit the `admin` cookie value to anything else, then reload `/admin`.
   - **Expected:** redirected back to `/admin/login` — the broken signature is rejected.
5. Post a logout. The simplest way is to add a logout button later (section 08); for now confirm the route works:

```powershell
node -e "const http=require('http');const req=http.request({host:'localhost',port:3000,path:'/admin/logout',method:'POST'},r=>{console.log('status',r.statusCode,'location',r.headers.location)});req.end()"
```

- **Expected:** prints `status 302 location /admin/login`.

### G. Test the QR helper

```powershell
node -e "require('./src/services/qr').qrDataUrl('http://localhost:3000/j/testtoken').then(u=>console.log(u.slice(0,40),'...len=',u.length))"
```

- **Expected:** prints something starting with `data:image/png;base64,iVBORw0KGgo ...len= <a few thousand>`. That confirms the QR service produces a real PNG data URL.

If every "Expected" above matches, section 03 is complete. Stop the running app with Ctrl+C in its window.
