// src/routes/auth.js
'use strict';

const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('../../config');
const { db } = require('../db');
const { requireGuest } = require('../middleware/session');
const photos = require('../services/photos');

const router = express.Router();

// 14 days in milliseconds — how long a guest/admin stays signed in.
const COOKIE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

// Returns fresh cookie options each call so config.COOKIE_SECURE is read at
// request time, not at module-load time. That keeps the value correct when the
// app starts before NODE_ENV is known, and lets tests toggle the flag.
function cookieOpts() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    signed: true,
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/',
  };
}

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
 * Save the avatar buffer via the photos service. Returns the relative
 * filename to store in guests.avatar_path, or null if no file was uploaded.
 */
async function trySaveAvatar(file, guestId) {
  if (!file || !file.buffer || file.buffer.length === 0) {
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
    res.status(404).render('partials/message-card', {
      title: 'Link not recognized',
      heading: 'Link Not Recognized',
      paragraphs: [
        'We could not find that private link. Double-check you scanned the QR code on your own place-card, or ask Lilly & Axel for help.',
      ],
    });
    return;
  }
  res.cookie('gsid', guest.token, cookieOpts());
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

// Shown when the uploaded avatar cannot be used — a type/size rejection from
// multer or bytes sharp cannot decode. Issue #187 binds tests to the substring
// "could not use that photo"; keep it if the copy is ever reworded.
const AVATAR_ERROR =
  'Sorry, we could not use that photo. Please try another one — or skip it for now and add one later.';

// POST /onboard — save the guest's name, optional avatar, optional socials,
// and mark them onboarded so they never see this form again.
//
// photos.uploadAvatar is invoked with an explicit callback (the same pattern as
// guest.js POST /me/edit) instead of being mounted as bare route middleware, so
// a fileFilter or size-limit rejection re-renders this form with a friendly
// error instead of falling through to the global 500 handler — and a corrupt
// image that sharp cannot decode is caught here rather than crashing the
// process (Express 4 does not catch async-handler rejections; issue #187).
router.post('/onboard', requireGuest, (req, res, next) => {
  photos.uploadAvatar(req, res, async (err) => {
    try {
      const name = ((req.body && req.body.name) || '').trim();

      // Re-render the form with an avatar error, keeping whatever name the
      // guest submitted so they do not have to retype it. The guest is NOT
      // marked onboarded on this path — they retry or skip the photo.
      function renderAvatarError() {
        res.status(400).render('onboard', {
          title: 'Welcome',
          error: AVATAR_ERROR,
          guest: { ...req.guest, name: name || req.guest.name },
        });
      }

      if (err) {
        // multer rejection: not an accepted image type (fileFilter) or over
        // the size limit.
        renderAvatarError();
        return;
      }

      if (!name) {
        res.status(400).render('onboard', {
          title: 'Welcome',
          error: 'Please tell us your name so it can appear on the leaderboard.',
          guest: req.guest,
        });
        return;
      }

      const socialLinks = buildSocialLinks(req.body);

      let avatarPath; // null if no uploaded file
      try {
        avatarPath = await trySaveAvatar(req.file, req.guest.id);
      } catch {
        // sharp could not decode the bytes (corrupt or mislabelled image).
        renderAvatarError();
        return;
      }

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
    } catch (e) {
      // Anything unexpected in this async callback (e.g. a DB write failure)
      // must not become an unhandled rejection that kills the process —
      // route it to the global error handler (500 page, server stays up).
      next(e);
    }
  });
});

// --- Admin login / logout ---------------------------------------------------

// Module-scoped lockout state. A single-admin app warrants a global counter;
// no per-IP tracking needed (see issue #37 for the trust-proxy rationale).
let failedAttempts = 0;
let lockedUntil = 0;

const ADMIN_LOGIN_TITLE = 'Admin Login';

// GET /admin/login — show the password form.
router.get('/admin/login', (req, res) => {
  res.render('admin-login', { title: ADMIN_LOGIN_TITLE, error: null });
});

// POST /admin/login — check password against the bcrypt hash on disk.
// Note: app.js (section 01) already parses urlencoded bodies globally, so we
// do NOT add an inline body parser here — req.body.password is already populated.
//
// Security note (issue #49): the password is evaluated BEFORE the lockout check.
// A correct password always authenticates and clears the failure counter, so the
// real admin cannot be locked out by others' failed attempts. Only wrong passwords
// increment the counter and are throttled.
router.post('/admin/login', async (req, res) => {
  const password = req.body.password || '';

  let hash;
  try {
    hash = fs.readFileSync(config.ADMIN_HASH_PATH, 'utf8').trim();
  } catch (err) {
    res.status(500).render('admin-login', {
      title: ADMIN_LOGIN_TITLE,
      error: 'The admin area is not set up yet. Please ask the host to finish setup.',
    });
    return;
  }

  const ok = await bcrypt.compare(password, hash);
  if (ok) {
    // Correct password — clear any active lockout and authenticate.
    failedAttempts = 0;
    lockedUntil = 0;
    res.cookie('admin', '1', cookieOpts());
    // Lands on the admin dashboard, mounted at /admin.
    res.redirect('/admin');
    return;
  }

  // Wrong password — check lockout window first, then increment.
  if (Date.now() < lockedUntil) {
    res.status(429).render('admin-login', {
      title: ADMIN_LOGIN_TITLE,
      error: 'Too many failed attempts. Please wait before trying again.',
    });
    return;
  }

  failedAttempts += 1;
  if (failedAttempts >= config.ADMIN_LOGIN_MAX_ATTEMPTS) {
    lockedUntil = Date.now() + config.ADMIN_LOGIN_LOCKOUT_MS;
    failedAttempts = 0;
  }
  res.status(401).render('admin-login', {
    title: ADMIN_LOGIN_TITLE,
    error: 'Incorrect password. Please try again.',
  });
});

// POST /admin/logout — clear the admin cookie.
router.post('/admin/logout', (req, res) => {
  res.clearCookie('admin', { path: '/' });
  res.redirect('/admin/login');
});

module.exports = router;
