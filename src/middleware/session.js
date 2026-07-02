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
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=EB+Garamond:wght@400;600&display=swap" rel="stylesheet">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#ffffff;color:#467058;font-family:'EB Garamond',Georgia,serif;padding:24px;}
  .card{background:#f0f4f2;border:1px solid #aebbb2;border-radius:14px;max-width:380px;
        width:100%;padding:32px 24px;text-align:center;}
  .heart{fill:#467058;display:inline-block;margin-bottom:12px;}
  h1{font-family:'Cormorant Garamond',Georgia,serif;color:#467058;font-size:1.9rem;font-weight:600;
     letter-spacing:0.03em;margin:.2em 0 .4em;}
  p{line-height:1.6;margin:.5em 0;color:#6e8478;font-size:1.05rem;}
  .hint{font-size:0.9rem;color:#aebbb2;}
</style>
</head>
<body>
  <div class="card">
    <svg class="heart" viewBox="0 0 24 24" width="32" height="32" aria-hidden="true"><path d="M12 21s-8.5-5.3-8.5-11.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 3.2C20.5 15.7 12 21 12 21z"/></svg>
    <h1>Private Link Needed</h1>
    <p>This page is for guests who have signed in with their own private link.</p>
    <p>Find your <strong>place-card QR code</strong> and scan it with your phone's camera, or ask Lilly &amp; Axel for your link.</p>
    <p class="hint">Once you scan it, you will stay signed in on this phone.</p>
  </div>
</body>
</html>`;
}

module.exports = { attachGuest, requireGuest, requireAdmin };
