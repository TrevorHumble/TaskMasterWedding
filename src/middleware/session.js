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
 * Write a one-shot task-complete reward payload (issue #255): the fresh points
 * total and any newly-earned badge codes from a `created` task submission.
 * Follows setFlash's exact cookie pattern (signed, httpOnly, 30s maxAge) as a
 * PARALLEL cookie rather than folding into the `flash` shape, so the success
 * card's richer payload never has to be shoehorned through {type, msg}. This
 * is the single canonical writer of the signed `taskComplete` cookie; attachGuest
 * below is the single reader/clearer, same division as setFlash/flash.
 *
 * @param {object} res
 * @param {{points: number, newBadgeIds: string[]}} payload
 */
function setTaskCompleteReward(res, payload) {
  res.cookie('taskComplete', JSON.stringify(payload), {
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

  // One-shot task-complete reward (issue #255): same read-then-clear shape as
  // flash above, into its own res.locals key so it never collides with the
  // {type,msg} flash shape. Defensive shape guards (typeof points === 'number',
  // Array.isArray(newBadgeIds)) protect the one caller of this local
  // (GET /tasks/:id in routes/guest.js) from a malformed payload — this cookie
  // is signed so it cannot be tampered with in transit, but a stale/oddly-
  // shaped value should degrade to "no success card" rather than render "you're
  // at undefined points".
  let taskCompleteReward = null;
  const rawTaskComplete = req.signedCookies && req.signedCookies.taskComplete;
  if (typeof rawTaskComplete === 'string' && rawTaskComplete.length > 0) {
    try {
      const parsed = JSON.parse(rawTaskComplete);
      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof parsed.points === 'number' &&
        Array.isArray(parsed.newBadgeIds)
      ) {
        taskCompleteReward = parsed;
      }
    } catch (e) {
      taskCompleteReward = null;
    }
    res.clearCookie('taskComplete', { path: '/' });
  }

  // The success card supersedes any concurrent plain flash. This guards the
  // double-tap race: a guest tapping submit twice fires a `created` POST (writes
  // the taskComplete cookie) then a `replaced` POST (writes a "Photo replaced!"
  // flash) before the redirect GET runs, so both cookies arrive together. Before
  // #255 both messages shared the single `flash` cookie and the second overwrote
  // the first; splitting the card onto its own cookie reintroduced the chance of
  // showing both at once. When the richer card is present it stands alone — the
  // plain flash is dropped (the flash cookie was already read-and-cleared above,
  // so this only affects what renders this once).
  if (taskCompleteReward) {
    res.locals.flash = null;
  }
  res.locals.taskCompleteReward = taskCompleteReward;

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
 * Gate for guest-only pages. If no guest is attached, send the visitor to
 * the shared entry point (GET /join) instead of walling them off with a
 * message card (issue #241, AC5) — /join itself links to /login for anyone
 * who already has an account, so a signed-out visitor is always one tap from
 * getting back in, on any device. Assumes attachGuest already ran earlier in
 * the chain.
 */
function requireGuest(req, res, next) {
  if (req.guest) {
    return next();
  }
  res.redirect('/join');
  return undefined;
}

/**
 * The single owner of "is this request an authenticated admin" — a valid
 * signed `admin` cookie equal to "1". requireAdmin (below) and the
 * taken-down file guards in services/photos.js (issue #191) both need this
 * exact predicate; both import it from here rather than re-testing the
 * cookie in more than one place.
 */
function isAdminRequest(req) {
  return !!(req.signedCookies && req.signedCookies.admin === '1');
}

/**
 * Gate for admin-only pages. Otherwise send the visitor to the admin login form.
 */
function requireAdmin(req, res, next) {
  if (isAdminRequest(req)) {
    return next();
  }
  res.redirect('/admin/login');
  return undefined;
}

module.exports = {
  attachGuest,
  requireGuest,
  requireAdmin,
  setFlash,
  setTaskCompleteReward,
  isAdminRequest,
};
