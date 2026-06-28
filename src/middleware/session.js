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
