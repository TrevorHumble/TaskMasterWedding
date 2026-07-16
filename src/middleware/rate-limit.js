// src/middleware/rate-limit.js
//
// General-purpose fixed-window rate-limiting middleware (issue #283) for the
// unauthenticated and authenticated-guest WRITE routes this app exposes on
// the public internet: POST /join, POST /login (IP-keyed, src/routes/auth.js)
// and POST /tasks/:id/submit, POST /me/edit, POST /bug-report (guest-keyed,
// src/routes/guest.js), POST /p/:id/like, POST /p/:id/comments (guest-keyed,
// src/routes/community.js).
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

  /**
   * Evict the entry whose window expires soonest — the one closest to being
   * reclaimed by a sweep anyway, so it costs the least to drop. Called only
   * when the map is at the cap after a sweep freed nothing.
   * @returns {boolean} true if an entry was evicted (false only when empty).
   */
  function evictSoonestExpiring() {
    let victim = null;
    let soonest = Infinity;
    for (const [k, v] of buckets) {
      if (v.resetAt < soonest) {
        soonest = v.resetAt;
        victim = k;
      }
    }
    if (victim === null) return false;
    buckets.delete(victim);
    return true;
  }

  function rateLimiter(req, res, next) {
    const resolvedWindowMs = resolve(windowMs);
    const resolvedMax = resolve(max);
    const key = keyFn(req);
    const nowMs = now();

    let entry = buckets.get(key);
    if (!entry || nowMs >= entry.resetAt) {
      // New key, or this key's prior window has elapsed: start a fresh
      // window. The sweep + cap (see the two-step note in the file header)
      // run only for a genuinely NEW key — an existing key's own window
      // rolling over reuses its slot and cannot grow the map.
      if (!entry) {
        const resolvedTrackedMax = resolve(trackedMax);
        if (buckets.size >= resolvedTrackedMax) {
          // Step 1: reclaim anything already expired. May free nothing —
          // inside one window there is nothing to reclaim.
          for (const [k, v] of buckets) {
            if (nowMs >= v.resetAt) buckets.delete(k);
          }
          // Step 2: the real bound. Evict until this insert lands at or under
          // the cap. A loop, not one eviction: trackedMax is read fresh, so a
          // lowered value must be converged on rather than approached one
          // entry per request. evictSoonestExpiring returning false means the
          // map is empty, which terminates the loop.
          while (buckets.size >= resolvedTrackedMax) {
            if (!evictSoonestExpiring()) break;
          }
        }
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
 * (src/routes/guest.js's upload/social limiters, src/routes/community.js's
 * like+comments limiter). A signed-out caller never actually reaches a
 * guest-gated handler (requireGuest redirects/403s first), so the IP
 * fallback here is a defensive default, not a real bucket in practice — but
 * one function is still the single place that decision is written, instead
 * of each route file re-typing the same ternary.
 * @param {import('express').Request} req
 * @returns {string}
 */
function guestOrIpKey(req) {
  return req.guest ? 'g' + req.guest.id : 'ip:' + req.ip;
}

module.exports = { createRateLimiter, guestOrIpKey };
