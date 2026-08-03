// src/middleware/rate-limit.js
//
// General-purpose fixed-window rate-limiting middleware (issue #283) for the
// unauthenticated and authenticated-guest WRITE routes this app exposes on
// the public internet: POST /join, POST /login (IP-keyed, src/routes/auth.js)
// and POST /tasks/:id/submit (guest-keyed, src/routes/guest/tasks.js),
// POST /me/edit (src/routes/guest/profile.js), POST /bug-report
// (src/routes/guest/bug-report.js), POST /p/:id/like, POST /p/:id/comments
// (guest-keyed, src/routes/community.js), and POST /client-error
// (guest-or-IP-keyed, issue #1021, src/routes/guest/client-error.js -- see
// src/app.js's mount comment for why that one route's IP branch is a real
// bucket, not a defensive default).
//
// This module also exports `sweepAndEvictUnderCap` (issue #1021), the
// bounded-TTL-map mechanism `createRateLimiter` uses internally, as a
// general-purpose primitive: `client-error.js`'s dedupe Map, which is not a
// rate limiter, calls it directly rather than hand-rolling a second copy.
// See that function's own doc comment for the two-step reasoning.
//
// DISTINCT FROM src/services/rate-limit.js: that module is the #247/#281
// per-guest SLIDING-WINDOW limiter that owns POST /memories and the
// HEIC-decode throttle. This module is a separate FIXED-WINDOW limiter for a
// different set of routes — POST /memories is never wired through this
// module, so the two limiters never double-count the same request. See that
// file's own header comment for the same boundary stated from its side.
//
// Fixed window (not sliding, unlike the #247 service): a key's count resets
// the instant its window elapses rather than decaying continuously. Simpler
// and cheaper per-request than a sliding window, and adequate here — these
// routes bound abuse floods, not precise fairness across a window boundary.
//
// No new dependency (issue constraint): one Map per limiter instance, keyed
// by whatever keyFn returns. No setInterval anywhere in this app (it would
// hold the vitest process open), so memory hygiene happens on insert instead,
// in TWO steps that do different jobs — the first alone is not a bound:
//
//   1. Sweep expired entries. Reclaims everything whose window has already
//      elapsed. Inside a single window, though, NOTHING is expired, so this
//      step can free zero — it is opportunistic cleanup, not a limit.
//   2. Enforce config.RATE_LIMIT_TRACKED_MAX. If the map is still at the cap
//      after sweeping, evict the entry whose window expires soonest, so an
//      insert can never push the map past the cap. This is the actual bound:
//      it is what holds when a distinct-key flood arrives faster than windows
//      retire, which is exactly an attacker's shape on the IP-keyed limiters.
//
// Both steps run only when a genuinely NEW key is inserted past the cap, so
// the steady-state per-request cost is a single Map lookup.

'use strict';

const config = require('../../config');

function resolve(value) {
  return typeof value === 'function' ? value() : value;
}

/**
 * The bounded-TTL-map mechanism itself, shared by every caller that keeps a
 * "key -> something with an expiry" Map and must stop it growing without
 * ever running a `setInterval` (see the file header for why: this app has
 * none, so memory hygiene happens on insert). Two steps -- sweep expired
 * entries, then evict soonest-to-expire survivors until back under `cap` --
 * run only when the map is already at `cap` and a genuinely NEW key is about
 * to be inserted; see the file header for the full two-step reasoning.
 *
 * Two callers today, two different entry shapes, which is why eviction is
 * expiry-only and the caller supplies `getExpiry`: `createRateLimiter`'s
 * `buckets` Map stores `{ count, resetAt }` objects (below); `client-error.js`'s
 * dedupe Map stores the expiry number itself as the value.
 *
 * @param {Map<any, any>} map
 * @param {number} nowMs
 * @param {number} cap
 * @param {function(value: any): number} getExpiry - reads an entry's expiry
 *   timestamp (ms epoch) given its Map value.
 */
function sweepAndEvictUnderCap(map, nowMs, cap, getExpiry) {
  if (map.size < cap) return;
  for (const [k, v] of map) {
    if (nowMs >= getExpiry(v)) map.delete(k);
  }
  while (map.size >= cap) {
    let victim = null;
    let soonest = Infinity;
    for (const [k, v] of map) {
      const expiry = getExpiry(v);
      if (expiry < soonest) {
        soonest = expiry;
        victim = k;
      }
    }
    if (victim === null) break;
    map.delete(victim);
  }
}

/**
 * Create one Express middleware instance backed by its own fixed-window Map.
 * Route wiring creates one instance per route GROUP at module load, so every
 * route sharing that instance shares its counts (see the route files' own
 * comments for which routes group together and why).
 *
 * @param {object} opts
 * @param {number|function(): number} opts.windowMs - window length in ms, or
 *   a zero-arg function read fresh on every request. Route wiring passes a
 *   function (`() => config.SOME_KEY`) rather than the resolved number, so a
 *   test can lower a config.RATE_LIMIT_* value AFTER the app (and its
 *   routers) have already loaded, with no re-require needed.
 * @param {number|function(): number} opts.max - attempts allowed per window,
 *   same function-or-number contract as windowMs.
 * @param {function(req): string} opts.keyFn - derives the bucket key from a
 *   request (per-guest or per-IP; see the file header for which routes use
 *   which).
 * @param {function(): number} [opts.now=Date.now] - injectable clock.
 * @param {number|function(): number} [opts.trackedMax] - hard cap on distinct
 *   tracked keys, same function-or-number contract as windowMs. Defaults to
 *   reading config.RATE_LIMIT_TRACKED_MAX fresh per insert.
 * @returns {function(req, res, next): void} Express middleware. Also carries
 *   a `_size()` test-only accessor returning the current bucket count.
 */
function createRateLimiter({
  windowMs,
  max,
  keyFn,
  now = Date.now,
  trackedMax = () => config.RATE_LIMIT_TRACKED_MAX,
}) {
  // key -> { count, resetAt }
  const buckets = new Map();

  function rateLimiter(req, res, next) {
    const resolvedWindowMs = resolve(windowMs);
    const resolvedMax = resolve(max);
    const key = keyFn(req);
    const nowMs = now();

    let entry = buckets.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      // New key, or this key's prior window has elapsed: start a fresh
      // window. sweepAndEvictUnderCap (see its own doc comment for the
      // two-step reasoning) runs only for a genuinely NEW key -- an existing
      // key's own window rolling over reuses its slot and cannot grow the map.
      if (!entry) {
        const resolvedTrackedMax = resolve(trackedMax);
        sweepAndEvictUnderCap(buckets, nowMs, resolvedTrackedMax, (v) => v.resetAt);
      }
      entry = { count: 0, resetAt: nowMs + resolvedWindowMs };
      buckets.set(key, entry);
    }

    if (entry.count < resolvedMax) {
      entry.count += 1;
      return next();
    }

    // Over the limit: reject with the same call signature app.js's global
    // error handler uses (res.status(...).render('error', { message })), per
    // issue #283's plan. Retry-After is clamped to at least 1 second so a
    // request landing right at the window boundary never reports 0 or a
    // negative value.
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - nowMs) / 1000));
    res.status(429).set('Retry-After', String(retryAfterSec));
    return res.render('error', {
      message: 'Too many requests. Please wait a moment and try again.',
    });
  }

  // Test-only accessor: current number of tracked keys. Not used by any
  // route; exists so a test can assert the sweep/cap behavior without
  // reaching into this closure's private Map.
  rateLimiter._size = () => buckets.size;

  return rateLimiter;
}

/**
 * The single owner of the "guest-keyed, falls back to an IP bucket when
 * signed out" key rule shared by every guest-keyed limiter this app wires up
 * (src/routes/guest/shared.js's upload/social limiters, src/routes/community.js's
 * like+comments limiter, src/routes/guest/client-error.js's own limiter):
 * one function, instead of each route file re-typing the same ternary.
 * Whether the IP branch is a live bucket or a defensive default a
 * signed-out caller can never reach differs per limiter: see src/app.js's
 * POST /client-error mount comment for the one exception and why.
 * @param {import('express').Request} req
 * @returns {string}
 */
function guestOrIpKey(req) {
  return req.guest ? 'g' + req.guest.id : 'ip:' + req.ip;
}

module.exports = { createRateLimiter, guestOrIpKey, sweepAndEvictUnderCap };
