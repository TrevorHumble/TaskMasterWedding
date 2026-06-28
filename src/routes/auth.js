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
  path: '/',
};

// Avatar upload: keep the file in memory so the photos service (section 05)
// can process the buffer; only one file, field name "avatar".
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.MAX_UPLOAD_BYTES, files: 1 },
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
    guest: req.guest,
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
      guest: req.guest,
    });
    return;
  }

  const socialLinks = buildSocialLinks(req.body);
  const avatarPath = await trySaveAvatar(req.file, req.guest.id); // null if no file / service

  if (avatarPath) {
    db.prepare(
      'UPDATE guests SET name = ?, social_links = ?, avatar_path = ?, onboarded = 1 WHERE id = ?'
    ).run(name, socialLinks, avatarPath, req.guest.id);
  } else {
    db.prepare('UPDATE guests SET name = ?, social_links = ?, onboarded = 1 WHERE id = ?').run(
      name,
      socialLinks,
      req.guest.id
    );
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
      error:
        'Admin password is not set up yet. Run: node scripts/set-admin-password.js ButtMonster',
    });
    return;
  }

  const ok = bcrypt.compareSync(password, hash);
  if (!ok) {
    res.status(401).render('admin-login', {
      title: 'Admin Login',
      error: 'Incorrect password. Please try again.',
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
