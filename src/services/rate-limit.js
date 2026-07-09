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
//   - hasFreeSpace(minFreeBytes): the global disk-space guard. Reads free
//     bytes on config.DATA_DIR and returns true iff at least minFreeBytes are
//     free. The free-space reader is INJECTABLE (see setFreeSpaceReader /
//     the `read` parameter) so tests exercise the guard without manipulating
//     a real disk.
//
// WHY IN-PROCESS / IN-MEMORY: this app is a single Node process serving one
// weekend event on one laptop. A Map keyed by guest id is the right weight —
// no Redis, no npm dependency, no cross-process coordination to get wrong. The
// window state is deliberately ephemeral: a restart clears it, which for a
// rate limiter fails OPEN (a restarted server forgets prior attempts), an
// acceptable trade for an anti-abuse throttle whose only job is to stop one
// guest looping uploads, not to enforce a hard quota.

'use strict';

const fs = require('fs');
const config = require('../../config');

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

/**
 * Clear all recorded attempts. Exposed for tests that want a clean window;
 * not used by the app in normal operation.
 */
function _resetRateLimiter() {
  attemptsByGuest.clear();
}

// ---------------------------------------------------------------------------
// Global disk-space guard.
// ---------------------------------------------------------------------------

/**
 * Default free-space reader: free bytes on config.DATA_DIR via fs.statfs.
 *
 * fs.statfs (Node >= 18.15; confirmed available on this app's Node 24) yields
 * a StatFs whose `bsize` (block size) times `bavail` (blocks available to an
 * unprivileged process) is the free bytes an app may actually write. We use
 * bavail, not bfree, because bfree includes root-reserved blocks a normal
 * process cannot use.
 *
 * @param {string} dir - directory on the volume to measure.
 * @returns {Promise<number>} free bytes available on that volume.
 */
function defaultFreeSpaceReader(dir) {
  return new Promise((resolve, reject) => {
    fs.statfs(dir, (err, stats) => {
      if (err) return reject(err);
      resolve(stats.bsize * stats.bavail);
    });
  });
}

// The active free-space reader. Swappable via setFreeSpaceReader so the app
// wires the real fs.statfs reader while a test injects a stub returning a
// chosen byte count — no real disk manipulation needed (AC12).
let freeSpaceReader = defaultFreeSpaceReader;

/**
 * Replace the free-space reader. A test passes a stub `(dir) => Promise<number>`
 * (or a plain number-returning function) to simulate a full or ample disk;
 * passing nothing restores the real fs.statfs reader.
 * @param {((dir: string) => (number|Promise<number>)) | null} reader
 */
function setFreeSpaceReader(reader) {
  freeSpaceReader = reader || defaultFreeSpaceReader;
}

/**
 * Is there at least `minFreeBytes` free on the data volume?
 *
 * Deep by design: the caller passes only the threshold it cares about and gets
 * a boolean; which directory is measured (config.DATA_DIR) and how free space
 * is read (the injectable reader) stay inside this module.
 *
 * @param {number} [minFreeBytes=config.MIN_FREE_DISK_BYTES]
 * @param {string} [dir=config.DATA_DIR] - volume to measure (override for tests).
 * @returns {Promise<boolean>} true iff free space >= minFreeBytes.
 */
async function hasFreeSpace(minFreeBytes = config.MIN_FREE_DISK_BYTES, dir = config.DATA_DIR) {
  const free = await freeSpaceReader(dir);
  return free >= minFreeBytes;
}

module.exports = {
  recordMemoryAttempt,
  hasFreeSpace,
  setFreeSpaceReader,
  defaultFreeSpaceReader,
  _resetRateLimiter,
};
