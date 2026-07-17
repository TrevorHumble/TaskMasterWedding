// src/services/rate-limit.js
//
// Abuse guardrails for the memory-upload path (issue #247). Two small,
// dependency-free primitives, each deep enough that a caller passes only what
// varies per call (a guest id, a byte threshold) and never touches the
// internal bookkeeping:
//
//   - recordMemoryAttempt(guestId): a per-guest SLIDING-WINDOW rate limiter.
//     Returns { allowed } — true if this attempt is within
//     config.MEMORY_RATE_MAX in the last config.MEMORY_RATE_WINDOW_MS, false
//     if it would exceed it. A denied attempt is NOT recorded (so a guest who
//     waits out the window is not permanently penalised by rejected tries).
//
//   - hasFreeSpace(minFreeBytes): the global disk-space guard, re-exported
//     from src/utils/free-space.js (moved there by issue #558 so
//     scripts/backup.js can use the same disk primitive without depending on
//     this rate-limiting module). Reads free bytes on config.DATA_DIR and
//     returns true iff at least minFreeBytes are free. The free-space reader
//     is INJECTABLE (see setFreeSpaceReader) so tests exercise the guard
//     without manipulating a real disk.
//
// WHY IN-PROCESS / IN-MEMORY: this app is a single Node process serving one
// weekend event on one laptop. A Map keyed by guest id is the right weight —
// no Redis, no npm dependency, no cross-process coordination to get wrong. The
// window state is deliberately ephemeral: a restart clears it, which for a
// rate limiter fails OPEN (a restarted server forgets prior attempts), an
// acceptable trade for an anti-abuse throttle whose only job is to stop one
// guest looping uploads, not to enforce a hard quota.
//
// DISTINCT FROM src/middleware/rate-limit.js (issue #283): that module is a
// separate FIXED-WINDOW limiter backing POST /join, POST /login, POST
// /tasks/:id/submit, POST /me/edit, POST /bug-report, POST /p/:id/like, and
// POST /p/:id/comments. This service keeps owning POST /memories (via
// recordMemoryAttempt below) and the HEIC-decode throttle
// (recordHeicDecodeAttempt) — neither route is ever wired through the #283
// middleware, so the two limiters never double-count the same request.

'use strict';

const config = require('../../config');
const { hasFreeSpace, setFreeSpaceReader, defaultFreeSpaceReader } = require('../utils/free-space');

// ---------------------------------------------------------------------------
// Per-guest sliding-window rate limiter.
// ---------------------------------------------------------------------------

// guestId -> number[] of attempt timestamps (ms epoch) still inside the window.
// Timestamps older than the window are pruned lazily on each check, so the
// array for a guest never grows past MEMORY_RATE_MAX entries in steady state.
const attemptsByGuest = new Map();

/**
 * Record a memory-batch attempt for a guest and decide whether it is allowed.
 *
 * Sliding window: an attempt is allowed when the number of attempts already
 * recorded within the last `windowMs` is strictly less than `max`. An allowed
 * attempt is appended to the guest's window; a DENIED attempt is not recorded,
 * so rejected tries do not extend the penalty past the real window.
 *
 * @param {number} guestId
 * @param {object} [opts]
 * @param {number} [opts.max=config.MEMORY_RATE_MAX] - max attempts per window.
 * @param {number} [opts.windowMs=config.MEMORY_RATE_WINDOW_MS] - window length.
 * @param {number} [opts.now=Date.now()] - injectable clock for deterministic tests.
 * @returns {{ allowed: boolean, remaining: number }} remaining is how many more
 *          attempts are permitted in the current window AFTER this one (0 when denied).
 */
function recordMemoryAttempt(guestId, opts = {}) {
  const max = typeof opts.max === 'number' ? opts.max : config.MEMORY_RATE_MAX;
  const windowMs = typeof opts.windowMs === 'number' ? opts.windowMs : config.MEMORY_RATE_WINDOW_MS;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const cutoff = now - windowMs;

  const raw = attemptsByGuest.get(guestId) || [];
  // Prune anything that has aged out of the window.
  const live = raw.filter((ts) => ts > cutoff);

  if (live.length >= max) {
    // Over the limit: do NOT record this attempt (so a guest who stops trying
    // recovers exactly one window after their last ALLOWED attempt). Persist
    // the pruned list so the array does not keep stale timestamps.
    attemptsByGuest.set(guestId, live);
    return { allowed: false, remaining: 0 };
  }

  live.push(now);
  attemptsByGuest.set(guestId, live);
  return { allowed: true, remaining: max - live.length };
}

// ---------------------------------------------------------------------------
// Per-guest HEIC-DECODE sliding-window rate limiter (issue #281).
// Separate window/Map from the memory-batch limiter above: a guest's HEIC
// decode budget is independent of their memory-batch budget, and it is
// consumed only by files that actually sniff as HEIC (photos.js enforces the
// HEIC-only condition — non-HEIC uploads never call this). Same sliding-window
// shape and "denied attempts are not recorded" recovery semantics as
// recordMemoryAttempt.
// ---------------------------------------------------------------------------

// guestId -> number[] of HEIC-decode attempt timestamps still inside the window.
const heicDecodesByGuest = new Map();

/**
 * Record a HEIC-decode attempt for a guest and decide whether it is allowed.
 * Called by src/services/photos.js right before a HEIC decode, per HEIC file.
 *
 * @param {number} guestId
 * @param {object} [opts]
 * @param {number} [opts.max=config.HEIC_DECODE_RATE_MAX] - max decodes per window.
 * @param {number} [opts.windowMs=config.HEIC_DECODE_RATE_WINDOW_MS] - window length.
 * @param {number} [opts.now=Date.now()] - injectable clock for deterministic tests.
 * @returns {{ allowed: boolean, remaining: number }} remaining is how many more
 *          decodes are permitted in the current window AFTER this one (0 when denied).
 */
function recordHeicDecodeAttempt(guestId, opts = {}) {
  const max = typeof opts.max === 'number' ? opts.max : config.HEIC_DECODE_RATE_MAX;
  const windowMs =
    typeof opts.windowMs === 'number' ? opts.windowMs : config.HEIC_DECODE_RATE_WINDOW_MS;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const cutoff = now - windowMs;

  const raw = heicDecodesByGuest.get(guestId) || [];
  const live = raw.filter((ts) => ts > cutoff);

  if (live.length >= max) {
    // Over the limit: do NOT record this attempt, so a guest who stops trying
    // recovers exactly one window after their last ALLOWED decode.
    heicDecodesByGuest.set(guestId, live);
    return { allowed: false, remaining: 0 };
  }

  live.push(now);
  heicDecodesByGuest.set(guestId, live);
  return { allowed: true, remaining: max - live.length };
}

/**
 * Clear all recorded attempts (both limiters). Exposed for tests that want a
 * clean window; not used by the app in normal operation.
 */
function _resetRateLimiter() {
  attemptsByGuest.clear();
  heicDecodesByGuest.clear();
}

// ---------------------------------------------------------------------------
// Global disk-space guard -- implementation lives in src/utils/free-space.js
// (moved there by issue #558); hasFreeSpace/setFreeSpaceReader/
// defaultFreeSpaceReader are re-exported below unchanged so every existing
// caller and test keeps working without knowing the code moved.
// ---------------------------------------------------------------------------

module.exports = {
  recordMemoryAttempt,
  recordHeicDecodeAttempt,
  hasFreeSpace,
  setFreeSpaceReader,
  defaultFreeSpaceReader,
  _resetRateLimiter,
};
