// src/routes/guest/client-error.js
// POST /client-error: the browser-side JS crash beacon (issue #1021). Mounts
// directly in src/app.js, deliberately NOT nested inside src/routes/guest.js
// (whose router.use(requireGuest) would otherwise gate it): a crash on /join
// or /login, before a guest ever gets in, is precisely the case this route
// exists to catch, and an admin-console crash matters too. Still behind the
// app-wide csrfMiddleware (src/app.js): a JSON POST, so the double-submit
// header is verified the same way as any other non-multipart write.
//
// Log-only to stdout, via request-log.js's logClientError -- nothing is
// written to bug_reports (the human-authored, admin-UI channel; a machine
// stack trace there would train the host to ignore it) and no schema change.

'use strict';

const express = require('express');
const router = express.Router();

const crypto = require('crypto');

const config = require('../../../config');

// guestOrIpKey (issue #283) is the single owner of "guest-keyed, falls back
// to an IP bucket when signed out" -- see src/app.js's mount comment for why
// this route's IP branch is a real, load-bearing bucket rather than the
// defensive default every other guestOrIpKey caller gets.
const { guestOrIpKey, sweepAndEvictUnderCap } = require('../../middleware/rate-limit');

// clientErrorRateLimiter: its own instance, config.CLIENT_ERROR_RATE_MAX,
// constructed once in shared.js so this route and any future caller of it
// share the same counters rather than each minting a fresh Map.
const { clientErrorRateLimiter } = require('./shared');

// logClientError is request-log.js's single owner of this line's shape and
// emit path -- see DESIGN.md § "Client-error beacon: log-only, own budget,
// non-deferred, mounted outside `requireGuest` (#1021)" for why.
const { logClientError } = require('../../middleware/request-log');

// Server-side truncation is authoritative (issue #1021 design): applied
// here regardless of what the client already truncated, so an oversized
// direct POST (bypassing client-error.js entirely) still lands within these
// bounds. Named constants, same pattern as bug-report.js's BUG_REPORT_BODY_MAX,
// a plain per-route limit, not a config key, since these bounds are a
// property of this log line's shape, not something an operator would ever
// need to tune per deployment.
const CLIENT_ERROR_MESSAGE_MAX = 500;
const CLIENT_ERROR_STACK_MAX = 2000;
// url had no server-side bound before this line existed: an unsliced
// window.location.href on a direct POST (up to express.json's 16kb body
// limit, src/app.js) could write far more stdout through this one field than
// message or stack combined. Same authoritative-truncation posture as those
// two.
const CLIENT_ERROR_URL_MAX = 2000;

// Same-key, same-report reposts inside this window are the guest's OWN
// re-triggered error (a loop, a re-render), not a second distinct crash:
// issue #1021 AC3. A short in-memory window, not a DB table: this is a
// diagnostic dedupe, not a record that needs to survive a restart.
const CLIENT_ERROR_DEDUPE_WINDOW_MS = 30000;

// key -> expiresAt (ms epoch). Bounded by rate-limit.js's shared
// sweepAndEvictUnderCap helper -- see that function's own doc comment for
// the two-step reasoning.
const dedupeMap = new Map();

// Test-only clock seam. Deliberately NOT the same shape as
// rate-limit.js's createRateLimiter `now` option: that option is per-instance
// constructor injection, resolved once when a limiter is built, with no way
// to mutate a live instance. This is a module-global `let`; production code
// never touches this seam. _setNowForTest returns a restore closure so a
// caller can `finally { restore() }` rather than needing to know the prior
// value itself.
// @param {() => number} [fn] - defaults to Date.now.
// @returns {() => void} restores the clock to whatever it was before this call.
let _now = Date.now;
router._setNowForTest = (fn) => {
  const previous = _now;
  _now = typeof fn === 'function' ? fn : Date.now;
  return () => {
    _now = previous;
  };
};

/**
 * Records `key` as seen for CLIENT_ERROR_DEDUPE_WINDOW_MS (sweeping and
 * capping the map first when `key` is genuinely new -- see dedupeMap's own
 * comment) and returns whether it was already a duplicate. Named for the
 * write it performs, not the read: this is the module's only writer to
 * dedupeMap, so the caller skips logging when the return value is true, but
 * a call always happens regardless of the outcome.
 * @param {string} key
 * @param {number} nowMs
 * @returns {boolean} true when `key` was already seen inside its dedupe window.
 */
function noteReport(key, nowMs) {
  const expiresAt = dedupeMap.get(key);
  if (expiresAt !== undefined && nowMs < expiresAt) {
    return true;
  }
  if (expiresAt === undefined) {
    sweepAndEvictUnderCap(dedupeMap, nowMs, config.RATE_LIMIT_TRACKED_MAX, (v) => v);
  }
  dedupeMap.set(key, nowMs + CLIENT_ERROR_DEDUPE_WINDOW_MS);
  return false;
}

/**
 * A short, non-cryptographic fingerprint of the (already-truncated) message
 * + stack, used only to bucket "the same report" for dedupe, never a
 * security token, so collision resistance beyond "good enough to not
 * dedupe two genuinely different crashes together in practice" is not a
 * requirement here.
 * @param {string} text
 * @returns {string}
 */
function shortHash(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

// ---------------------------------------------------------------------------
// POST /client-error: a guest (or signed-out visitor) or admin's browser
// reports one window.onerror/unhandledrejection catch (issue #1021 AC1/AC2).
// clientErrorRateLimiter is this route's OWN budget (AC5), never
// socialRateLimiter's; see shared.js's own comment on why. CSRF is verified
// by the app-wide csrfMiddleware (src/app.js) before this handler ever runs
// (AC4); a request that fails that check never reaches here.
// ---------------------------------------------------------------------------
router.post('/client-error', clientErrorRateLimiter, function (req, res) {
  // Normalize any non-plain-object body (an array is valid strict JSON) to {} so the field reads below have one shape.
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};

  const message = (typeof body.message === 'string' ? body.message : '').slice(
    0,
    CLIENT_ERROR_MESSAGE_MAX
  );
  const stack = (typeof body.stack === 'string' ? body.stack : '').slice(0, CLIENT_ERROR_STACK_MAX);
  // The client sends window.location.href, query string included, unlike
  // request-log.js's own `path` field -- see DESIGN.md's "Client-error
  // beacon" entry for why the two fields take opposite postures on the same
  // question.
  const url = (typeof body.url === 'string' ? body.url : '').slice(0, CLIENT_ERROR_URL_MAX);
  // Header only, never the body (issue #1021 design): a client could claim
  // any User-Agent string in a JSON field, but the header is what the
  // browser itself actually sent.
  const userAgent = req.get('user-agent') || null;

  // message and stack are hashed SEPARATELY, then joined -- see DESIGN.md's
  // "Client-error beacon" entry for why a plain concatenation risks two
  // different reports colliding onto the same dedupe key.
  const key = guestOrIpKey(req) + ':' + shortHash(message) + ':' + shortHash(stack);
  if (!noteReport(key, _now())) {
    logClientError(req, { message, stack, url, userAgent });
  }

  // 204: the beacon fires fetch(...).catch(function(){}) and never reads the
  // response body (src/public/js/client-error.js, the recap.js fire-and-forget
  // precedent); nothing to return.
  res.status(204).end();
});

// Test-only accessor mirroring rate-limit.js's own rateLimiter._size()
// pattern: current number of tracked dedupe keys, so AC3's bound
// ("never exceeds config.RATE_LIMIT_TRACKED_MAX") is assertable without
// reaching into this closure's private Map.
router._size = () => dedupeMap.size;

module.exports = router;
