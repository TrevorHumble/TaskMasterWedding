// src/middleware/session.js
'use strict';

const { db } = require('../db');
const config = require('../../config');

/**
 * Write a one-shot flash message. This is the single canonical writer of the
 * signed `flash` cookie, whose shape ({ type: 'ok' | 'err', msg }) is read back
 * and cleared by attachGuest below and rendered by partials/header.ejs. kind is
 * 'success' (→ type 'ok') or 'error' (→ type 'err'); text is the message.
 */
function setFlash(res, kind, text) {
  const type = kind === 'success' ? 'ok' : 'err';
  res.cookie('flash', JSON.stringify({ type: type, msg: text }), {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    signed: true,
    path: '/',
    maxAge: 30 * 1000, // 30 seconds is plenty to survive one redirect
  });
}

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
  // clear it so the message shows exactly once. Shape is { type, msg } —
  // written by setFlash above (the single canonical writer) and read by
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

  // The guest masthead (issue #252) highlights the current section (Tasks /
  // Gallery / Leaderboard / My Profile) from the request path. attachGuest
  // already runs on every request and is the single writer of per-request
  // res.locals, so currentPath lives here rather than as a second middleware
  // — one place computes "what page is this", partials/header.ejs is the
  // only place that reads it.
  res.locals.currentPath = req.path;

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
  res.status(403).render('partials/message-card', {
    title: 'Your private link is needed',
    heading: 'Private Link Needed',
    paragraphs: [
      'This page is for guests who have signed in with their own private link.',
      {
        html: true,
        text: "Find your <strong>place-card QR code</strong> and scan it with your phone's camera, or ask Lilly &amp; Axel for your link.",
      },
    ],
    hint: 'Once you scan it, you will stay signed in on this phone.',
  });
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

module.exports = { attachGuest, requireGuest, requireAdmin, setFlash };
