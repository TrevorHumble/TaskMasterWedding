// src/routes/auth.js
'use strict';

const fs = require('fs');
const express = require('express');
const bcrypt = require('bcryptjs');

const config = require('../../config');
const { db, getGuestByContact } = require('../db');
const { requireGuest, setFlash, cookieOpts } = require('../middleware/session');
const photos = require('../services/photos');
const { normalizeContact, isValidPin, makeUniqueToken } = require('../services/identity');

const router = express.Router();

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
 * Stash the just-typed contact for 30 seconds (same lifetime as setFlash's
 * one-shot cookie) so GET /login can prefill its contact field right after
 * POST /join's duplicate-signup redirect. Signed + httpOnly, same as every
 * other cookie this app writes.
 */
function stashLoginContact(res, contactValue) {
  res.cookie('loginContact', contactValue, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    signed: true,
    path: '/',
    maxAge: 30 * 1000,
  });
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
  res.cookie('gsid', guest.token, cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS));
  // Anyone who has not finished onboarding goes to the form; everyone else
  // goes home. We key on the `onboarded` flag (not name-emptiness) so that
  // guests the admin pre-named still get to add an avatar and social links.
  if (!guest.onboarded) {
    res.redirect('/onboard');
  } else {
    res.redirect('/');
  }
});

// --- Self-serve signup (shared entry link, issue #240) ----------------------
//
// Every guest gets the SAME link (QR poster / email / place card) pointing at
// GET /join, instead of a private per-guest /j/:token link. Signup IS
// onboarding here — there is no separate "create the account" step followed
// by a name/avatar form; one POST does both, matching #241's re-entry
// counterpart (log back in with contact + PIN on any device).

// GET /join — show the signup form. A visitor who already has a valid guest
// session (attachGuest ran before this router and set req.guest) is bounced
// home so re-scanning the shared poster never dead-ends them on a form they
// do not need.
router.get('/join', (req, res) => {
  if (req.guest) {
    res.redirect('/');
    return;
  }
  res.render('join', { title: 'Join the Fun' });
});

// POST /join — create a playing guest from name + contact + self-chosen PIN,
// with an optional avatar, and sign them in immediately.
//
// photos.uploadAvatar is invoked with an explicit callback (same pattern as
// POST /onboard above) so a fileFilter/size rejection or a sharp-undecodable
// image never falls through to the global 500 handler or crashes the process
// (Express 4 does not catch async-handler rejections; issue #187).
router.post('/join', (req, res, next) => {
  photos.uploadAvatar(req, res, async (err) => {
    try {
      const name = ((req.body && req.body.name) || '').trim();

      // A rejected avatar (bad type / too large) is not itself a reason to
      // block signup — the guest is not mid-onboarding here, they are trying
      // to get in the door for the first time. Drop the avatar and continue;
      // they can add one later from their profile.
      const avatarRejected = Boolean(err);

      if (!name) {
        setFlash(res, 'error', 'Please enter your name.');
        res.redirect('/join');
        return;
      }

      const contact = normalizeContact(req.body && req.body.contact);
      if (!contact) {
        setFlash(res, 'error', 'Please enter a valid email or phone number.');
        res.redirect('/join');
        return;
      }

      if (!isValidPin(req.body && req.body.pin)) {
        setFlash(res, 'error', 'Please choose a 4-digit PIN (numbers only).');
        res.redirect('/join');
        return;
      }

      // Duplicate check: one guest per normalized contact. Route them to
      // re-entry instead of silently creating a second account.
      const existing = getGuestByContact(contact.value);
      if (existing) {
        setFlash(res, 'error', 'Looks like you already signed up — enter your PIN to get back in.');
        // Stash the contact they just typed so GET /login (below) can
        // prefill the field — they should not have to retype it. A one-shot
        // signed cookie, not a query parameter: a query parameter would
        // leave the contact sitting in the URL/browser history.
        stashLoginContact(res, contact.value);
        res.redirect('/login');
        return;
      }

      const token = makeUniqueToken();
      const info = db
        .prepare(
          `INSERT INTO guests (token, name, onboarded, contact, contact_type, pin)
           VALUES (?, ?, 1, ?, ?, ?)`
        )
        .run(token, name, contact.value, contact.type, req.body.pin);
      const guestId = info.lastInsertRowid;

      if (!avatarRejected) {
        try {
          await trySaveAvatar(req.file, guestId);
        } catch {
          // sharp could not decode the bytes (corrupt or mislabelled image).
          // The guest account is already created — do not block signup on a
          // bad photo; they can add one later from their profile.
        }
      }

      res.cookie('gsid', token, cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS));
      res.redirect('/');
    } catch (e) {
      // Anything unexpected in this async callback (e.g. a DB write failure)
      // must not become an unhandled rejection that kills the process —
      // route it to the global error handler (500 page, server stays up).
      next(e);
    }
  });
});

// --- Re-entry / login (issue #241) -------------------------------------------
//
// The signup counterpart at GET/POST /join: a guest who already has an
// account gets back in on ANY device with the same contact + 4-digit PIN
// they chose at signup, instead of needing their original private link.

const LOGIN_TITLE = 'Log In';
const LOGIN_FAIL_MESSAGE = "That contact and code don't match.";

// Per-normalized-contact lockout state — module-scoped Maps, the same shape
// as the admin lockout's two scalars above but keyed by contact.value
// because there are many guests, not one admin. Unlike the admin flow (where
// a correct password always wins, even mid-lockout, since only wrong
// passwords are throttled — issue #49), a guest's credential is a 4-digit PIN
// with only 10,000 possible values, so if the correct PIN always bypassed an
// active lockout the throttle would not actually slow a brute-force script —
// it would just wait out whatever counter and try again. AC4 requires the
// lockout to block EVEN the correct PIN until the window elapses, so here the
// lockout check runs before the credential check (the opposite order from
// admin/login).
const guestFailedAttempts = new Map(); // contact.value -> consecutive fail count
const guestLockedUntil = new Map(); // contact.value -> timestamp lockout ends

// GET /login — show the re-entry form. A visitor who already has a valid
// guest session is bounced home, same as GET /join. Prefills the contact
// field from the one-shot `loginContact` cookie stashed by POST /join's
// duplicate-signup redirect above, if present.
router.get('/login', (req, res) => {
  if (req.guest) {
    res.redirect('/');
    return;
  }
  const rawContact = req.signedCookies && req.signedCookies.loginContact;
  const contact = typeof rawContact === 'string' ? rawContact : '';
  if (contact) {
    res.clearCookie('loginContact', { path: '/' });
  }
  res.render('login', { title: LOGIN_TITLE, contact: contact, error: null });
});

// POST /login — contact + 4-digit PIN re-entry.
//
// One shared failure message for both an unknown contact and a wrong PIN
// (AC2/AC3) — anything else would let a visitor learn whether a given
// contact is registered just from the response, an account-existence oracle.
// For the same reason, the per-contact throttle below counts an
// unknown-contact attempt too: if only real accounts were throttled, hitting
// the lockout message would itself reveal the contact exists.
router.post('/login', (req, res) => {
  const contact = normalizeContact(req.body && req.body.contact);
  const rawContact = (req.body && req.body.contact) || '';
  const submittedPin = req.body && req.body.pin;

  // A contact that does not even parse to a normalized key has nothing to
  // throttle against — fail closed with the same shared message, no counter
  // touched (AC: missing/invalid contact -> shared "don't match" failure).
  if (!contact) {
    res.status(401).render('login', {
      title: LOGIN_TITLE,
      contact: rawContact,
      error: LOGIN_FAIL_MESSAGE,
    });
    return;
  }

  const key = contact.value;
  const now = Date.now();
  const lockedUntil = guestLockedUntil.get(key) || 0;

  if (now < lockedUntil) {
    res.status(429).render('login', {
      title: LOGIN_TITLE,
      contact: rawContact,
      error: 'Too many attempts. Try again in a few minutes.',
    });
    return;
  }

  const guest = getGuestByContact(key);
  // guest.pin can be null/empty for an older admin-created guest that never
  // set one (issue #239) — that must never match a submitted PIN, hence the
  // explicit non-empty-string check before the equality compare.
  const pinOk =
    Boolean(guest) &&
    typeof guest.pin === 'string' &&
    guest.pin.length > 0 &&
    typeof submittedPin === 'string' &&
    guest.pin === submittedPin;

  if (pinOk) {
    guestFailedAttempts.delete(key);
    guestLockedUntil.delete(key);
    res.cookie('gsid', guest.token, cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS));
    res.redirect('/');
    return;
  }

  // Wrong PIN, or no guest at all for this contact — count toward the
  // per-contact throttle either way (see the existence-oracle note above).
  const attempts = (guestFailedAttempts.get(key) || 0) + 1;
  if (attempts >= config.GUEST_LOGIN_MAX_ATTEMPTS) {
    guestLockedUntil.set(key, now + config.GUEST_LOGIN_LOCKOUT_MS);
    guestFailedAttempts.delete(key);
  } else {
    guestFailedAttempts.set(key, attempts);
  }

  res.status(401).render('login', {
    title: LOGIN_TITLE,
    contact: rawContact,
    error: LOGIN_FAIL_MESSAGE,
  });
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

      // First-time guests land on the how-to-play card (issue #246) instead
      // of straight to their profile, so they learn the three rules before
      // playing. ?first=1 tells that route to show the "Skip for now" link —
      // there is nothing to skip when the guest reaches it any other way.
      res.redirect('/how-to-play?first=1');
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
    res.cookie('admin', '1', cookieOpts(config.ADMIN_COOKIE_MAX_AGE_MS));
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
