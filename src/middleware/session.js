// src/middleware/session.js
'use strict';

const { db, getEventConfig, isCeremonyNoticeLive } = require('../db');
const config = require('../../config');
// buildMemoryBatchPartialPayload below needs to bound the encoded-on-the-wire
// byte size of a candidate cookie value before writing it. An earlier version
// of this file predicted that size EXACTLY by reproducing cookie-signature's
// sign() step (HMAC-SHA256 + base64) with node's own `crypto` module -- a
// third hand-copy of that formula alongside tests/helpers/testApp.js and
// scripts/loadtest.js (#931 design-philosophy re-check MAJOR 1). If that
// hand-copied formula ever drifted from what express's res.cookie({signed:
// true}) actually writes, encodedSignedCookieByteLength would under-count and
// an over-4096-byte cookie could ship and be silently discarded by the
// browser -- the guest gets no result card at all. encodedSignedCookieByteLength
// below no longer reproduces the sign step at all: it adds a fixed, documented
// UPPER BOUND (SIGNED_COOKIE_OVERHEAD_MAX) instead, so there is nothing left
// here that can drift out of sync with express's real signing behavior.

// The recap's cheap unread-count read (issue #644 plan step 6) — never the
// full row union (src/services/notifications.js's getRecap), which the
// strip/profile row do not need just to decide whether to show a count.
// getUnreadCount now needs a clock too (issue #778 — a task's
// live-transition/unseal/flash state is read AT an instant, never re-derived
// from server UTC); notifications.buildRecapClock is the one place that
// clock shape is assembled, so this file resolves its OWN timezone (below)
// and hands it in, rather than building the {todayIso, nowMs, timezone}
// literal itself.
const notifications = require('../services/notifications');

/**
 * The single owner of the signed-cookie attribute shape shared by the guest
 * `gsid` cookie and the admin `admin` cookie (issue #242). Only `maxAge`
 * differs between the two; every other attribute is identical, so both
 * src/routes/auth.js (sign-in / admin login) and attachGuest below (the
 * rolling guest-cookie refresh) call this one factory rather than each
 * building its own options object -- which would let the two drift apart.
 * Returns fresh options each call so config.COOKIE_SECURE is read at request
 * time, not at module-load time; that keeps the value correct when the app
 * starts before NODE_ENV is known, and lets tests toggle the flag.
 */
function cookieOpts(maxAgeMs) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.COOKIE_SECURE,
    signed: true,
    maxAge: maxAgeMs,
    path: '/',
  };
}

/**
 * Write a one-shot flash message. This is the single canonical writer of the
 * signed `flash` cookie, whose shape ({ type: 'ok' | 'err', msg }) is read back
 * and cleared by attachGuest below and rendered by partials/header.ejs. kind is
 * 'success' (→ type 'ok') or 'error' (→ type 'err'); text is the message.
 */
// The one-shot redirect cookies (flash, taskComplete) reuse cookieOpts above
// with a 30-second maxAge — long enough to survive one submit→redirect
// navigation. Sharing that one factory keeps their attribute shape from
// drifting from the gsid/admin cookies it already owns.
function setFlash(res, kind, text) {
  const type = kind === 'success' ? 'ok' : 'err';
  res.cookie('flash', JSON.stringify({ type: type, msg: text }), cookieOpts(30 * 1000));
}

/**
 * Write a one-shot task-complete reward payload (issue #255): the fresh points
 * total and any newly-earned badge codes from a `created` task submission.
 * A PARALLEL cookie to `flash` rather than folding into the `{type, msg}` flash
 * shape, so the success card's richer payload never has to be shoehorned through
 * it. Shares the signed-cookie shape via cookieOpts (30s maxAge). This is the
 * single canonical writer of the signed `taskComplete` cookie; attachGuest below
 * is the single reader/clearer, same division as setFlash/flash.
 *
 * @param {object} res
 * @param {{points: number, newBadgeIds: string[], luckyBonus?: number}} payload
 *   luckyBonus (issue #650) is an OPTIONAL third field — undefined for an
 *   ordinary completion, so JSON.stringify simply omits the key. No code
 *   change needed below: the reader's shape guard checks only `points` and
 *   `newBadgeIds`, so an extra key rides through untouched either way.
 */
function setTaskCompleteReward(res, payload) {
  res.cookie('taskComplete', JSON.stringify(payload), cookieOpts(30 * 1000));
}

// Issue #931 AC7: each failed filename stored in the memoryBatchPartial
// cookie is capped to this many CODE POINTS (Array.from + slice, not
// String.prototype.slice -- slice counts UTF-16 units and would cut a
// 40-character astral-plane name in half), with an ellipsis appended only
// when truncation actually happened.
const MEMORY_BATCH_FAILED_NAME_MAX_CODEPOINTS = 40;

// Issue #931 AC7: truncating names alone is not sufficient -- 9 failed files
// at 60 four-byte (astral-plane) characters each, even truncated to 40 code
// points, still overflow the ~4096-byte browser cookie cap once signed and
// percent-encoded (roughly 480 encoded bytes per name). This is the budget
// buildMemoryBatchPartialPayload stops appending names under, leaving real
// headroom below the browser cap.
const MEMORY_BATCH_COOKIE_BYTE_BUDGET = 3000;

/**
 * Truncate one failed filename to MEMORY_BATCH_FAILED_NAME_MAX_CODEPOINTS
 * code points, appending an ellipsis only when it was actually cut short.
 * Array.from(name) splits on code points (correctly pairing UTF-16
 * surrogate pairs for astral-plane characters), unlike String#slice, which
 * would split a surrogate pair in two and corrupt the character.
 */
function truncateFailedName(name) {
  const codepoints = Array.from(String(name));
  if (codepoints.length <= MEMORY_BATCH_FAILED_NAME_MAX_CODEPOINTS) {
    return codepoints.join('');
  }
  return codepoints.slice(0, MEMORY_BATCH_FAILED_NAME_MAX_CODEPOINTS).join('') + '…';
}

// Conservative UPPER BOUND on what express's res.cookie({signed: true}) adds
// on top of a JSON-stringified, percent-encoded payload -- derived, not
// reproduced, so nothing here can drift out of sync with express's actual
// signing code (#931 design-philosophy re-check MAJOR 1; see the file-header
// comment above). Express writes the signed cookie value as
// 's:' + value + '.' + base64url-no-padding(HMAC-SHA256(value, secret)),
// where the base64 MAC is always exactly 43 characters (SHA-256 is a fixed
// 32-byte digest -> ceil(32/3)*4 = 44 base64 chars, minus one '=' padding
// char always stripped = 43). Then the `cookie` package's serialize()
// percent-encodes the whole thing with encodeURIComponent:
//   's:'   -> 's%3A'                      = 4 encoded bytes
//   '.'    -> '.' (unreserved, unchanged) = 1 encoded byte
//   the 43 MAC chars -> each is one of [A-Za-z0-9+/], and encodeURIComponent
//     only touches '+' (-> '%2B') and '/' (-> '%2F'); every MAC char is
//     therefore AT MOST 3 encoded bytes -> 43 * 3 = 129 encoded bytes max
// Total: 4 + 1 + 129 = 134 bytes, always >= the real overhead (only equal in
// the worst case where every MAC char happens to be '+' or '/').
const SIGNED_COOKIE_OVERHEAD_MAX = 134;

/**
 * An upper-bound byte length for `payload` as it would ship on the wire,
 * signed and percent-encoded: the encoded JSON value plus
 * SIGNED_COOKIE_OVERHEAD_MAX (above). This is deliberately an OVER-estimate,
 * not the exact wire size -- buildMemoryBatchPartialPayload below compares it
 * against MEMORY_BATCH_COOKIE_BYTE_BUDGET, and the only way an over-estimate
 * can be wrong is by rejecting a name that would actually still have fit,
 * which drops that name into the "and <k> more" count slightly early. That
 * is the safe direction: the alternative -- an exact-but-fragile estimate
 * that could under-count if express's signing behavior ever changed --
 * risks writing a cookie over the browser's ~4096-byte cap, which the
 * browser then silently discards, losing the guest's result card entirely.
 */
function encodedSignedCookieByteLength(payload) {
  const encoded = encodeURIComponent(JSON.stringify(payload));
  return Buffer.byteLength(encoded, 'utf8') + SIGNED_COOKIE_OVERHEAD_MAX;
}

/**
 * Build the memoryBatchPartial cookie payload (issue #931 AC1/AC7): the
 * saved submission ids plus as many failed filenames as fit the cookie's
 * byte budget. Every name is truncated first (truncateFailedName above),
 * then each is checked in order against MEMORY_BATCH_COOKIE_BYTE_BUDGET: a
 * name that would push the encoded signed cookie value over budget is
 * skipped, but checking CONTINUES through the rest of the list rather than
 * stopping there (#931 review MINOR B) -- failed names can be any length
 * before truncation, so a shorter name later in the list can still fit even
 * though an earlier, longer one didn't. A name that does not fit is not
 * silently dropped from the guest's knowledge either way: `droppedCount`
 * carries how many were left out of the cookie, so the card can still say
 * "and <k> more" instead of just under-reporting the failure count
 * (recorded omission, issue #931).
 *
 * @param {number[]} okIds
 * @param {string[]} failedNames - raw multer originalnames; truncated here.
 * @returns {{okIds: number[], failed: string[], droppedCount: number}}
 */
function buildMemoryBatchPartialPayload(okIds, failedNames) {
  const truncated = failedNames.map(truncateFailedName);
  let stored = [];
  for (let i = 0; i < truncated.length; i++) {
    const candidate = stored.concat([truncated[i]]);
    const candidatePayload = {
      okIds: okIds,
      failed: candidate,
      droppedCount: truncated.length - candidate.length,
    };
    if (encodedSignedCookieByteLength(candidatePayload) > MEMORY_BATCH_COOKIE_BYTE_BUDGET) {
      // This name did not fit the budget -- skip it and keep scanning; do
      // NOT stop here (#931 review MINOR B). A later name can be shorter
      // than this one (names vary in original length before truncation), so
      // stopping at the first miss would drop a name that would have fit.
      continue;
    }
    stored = candidate;
  }
  return { okIds: okIds, failed: stored, droppedCount: truncated.length - stored.length };
}

/**
 * Write the one-shot memoryBatchPartial cookie (issue #931): a partial
 * memory-batch result -- which submissions saved, and which filenames
 * failed -- for GET /memories/new to read back exactly once and render as
 * the partial-failure result card. Same one-shot signed-cookie shape and 30s
 * cookieOpts as setFlash/setTaskCompleteReward above; this is the single
 * canonical writer, attachGuest below is the single reader/clearer.
 *
 * @param {object} res
 * @param {number[]} okIds - ids of the submissions that DID save.
 * @param {string[]} failedNames - original client filenames of the files
 *   that did NOT save (multer originalname, pre-truncation).
 */
function setMemoryBatchPartial(res, okIds, failedNames) {
  const payload = buildMemoryBatchPartialPayload(okIds, failedNames);
  res.cookie('memoryBatchPartial', JSON.stringify(payload), cookieOpts(30 * 1000));
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
    // Rolling refresh (issue #242, AC2): a valid guest re-issues the SAME
    // signed value with a fresh maxAge on every authenticated request, so the
    // 400-day clock restarts on every visit instead of counting down from
    // sign-in. Same cookie options as sign-in (cookieOpts above) so no
    // attribute can drift between the two writers. Only ever the gsid cookie
    // -- this never touches the admin cookie (AC3; requireAdmin/isAdminRequest
    // below are the only readers of that one, and neither is invoked here).
    if (guest) {
      res.cookie('gsid', token, cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS));
    }
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
    } catch {
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
    } catch {
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

  // One-shot partial-memory-batch result (issue #931): same read-then-clear
  // shape as flash/taskComplete above, into its own res.locals key. Shape
  // guard requires okIds/failed to both be arrays (a stale or tampered-shape
  // payload degrades to "no card" rather than throwing when GET /memories/new
  // reads it); droppedCount defaults to 0 when missing or not a number
  // rather than rejecting the whole payload over one optional field.
  let memoryBatchPartial = null;
  const rawMemoryBatchPartial = req.signedCookies && req.signedCookies.memoryBatchPartial;
  if (typeof rawMemoryBatchPartial === 'string' && rawMemoryBatchPartial.length > 0) {
    try {
      const parsed = JSON.parse(rawMemoryBatchPartial);
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray(parsed.okIds) &&
        Array.isArray(parsed.failed)
      ) {
        memoryBatchPartial = {
          okIds: parsed.okIds,
          failed: parsed.failed,
          droppedCount: typeof parsed.droppedCount === 'number' ? parsed.droppedCount : 0,
        };
      }
    } catch {
      memoryBatchPartial = null;
    }
    res.clearCookie('memoryBatchPartial', { path: '/' });
  }
  res.locals.memoryBatchPartial = memoryBatchPartial;

  // The guest masthead (issue #252) highlights the current section (Tasks /
  // Gallery / Leaderboard / My Profile) from the request path. attachGuest
  // already runs on every request and is the single writer of per-request
  // res.locals, so currentPath lives here rather than as a second middleware
  // — one place computes "what page is this", partials/header.ejs is the
  // only place that reads it.
  res.locals.currentPath = req.path;

  // The recap's unread count (issue #644 plan step 6) — one res.locals value
  // set here alongside currentPath, read directly by header.ejs (the strip)
  // and guest-home.ejs (the profile row's count chip) without every guest
  // route having to pass it explicitly. Read-only (no stamp, no write) AND
  // genuinely cheap — notifications.getUnreadCount is three indexed
  // COUNT(*) queries plus one bounded, unindexed scan of the (small,
  // wedding-sized) tasks table for the fourth, announcements source (issue
  // #778) — never a row union, so — unlike the recap PAGE below — it is safe
  // to compute on every request, including a POST that redirects without
  // ever rendering a page.
  //
  // recapRows/recapHasMore do NOT live here (#644): getRecap runs a full
  // three-source merge-and-sort internally before slicing, so calling it
  // unconditionally on every request — including one that never renders the
  // recap panel — would not be cheap. Assembling the first page is now
  // src/services/render-locals.js's withBadgeMoment() job instead — the
  // render-time-only helper every guest res.render() already passes through
  // for the unrelated badgeMoment stamp — so it only ever runs for a request
  // that is actually about to render a guest page. See that module's own
  // comment for the full reasoning.
  if (guest) {
    // One request-scoped clock (issue #778) — this file resolves its own
    // timezone (cheap: a settings-table SELECT this function already runs
    // elsewhere in the request cycle) and hands it to
    // notifications.buildRecapClock, the one place the clock's shape is
    // assembled. eventConfig is read once here and reused below for the
    // ceremony notice (issue #1042) rather than a second settings read.
    const eventConfig = getEventConfig();
    const clock = notifications.buildRecapClock(eventConfig.timezone);
    res.locals.recapUnreadCount = notifications.getUnreadCount(guest.id, clock);

    // The ceremony photo-notice band (issue #1042 plan step 4): both facts
    // come from this same config read and the clock already built above —
    // no new query, no second middleware. partials/header.ejs and
    // views/how-to-play.ejs are the two readers. `enabled` is the raw
    // toggle (how-to-play.ejs's onboarding row is date-independent by
    // design); `live` is the folded enabled-AND-today-is-the-day predicate
    // (src/db/event-config.js's isCeremonyNoticeLive, the single owner of
    // that AND) the day-of band gates on.
    res.locals.ceremonyNotice = {
      enabled: eventConfig.ceremonyNotice,
      live: isCeremonyNoticeLive(eventConfig, clock.todayIso),
    };
  } else {
    res.locals.recapUnreadCount = 0;
  }

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
 * taken-down file guards in services/photos/moderation.js (issue #191) both need this
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
  setMemoryBatchPartial,
  isAdminRequest,
  cookieOpts,
};
