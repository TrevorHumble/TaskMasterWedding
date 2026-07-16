// src/services/lockout.js
//
// Persistent admin-login lockout state (issue #283), replacing the
// module-scoped `failedAttempts`/`lockedUntil` scalars src/routes/auth.js
// used to carry (issue #49's original brute-force throttle). Backed by the
// `settings` key/value table (src/db.js's ensureSettingsTable) so the lockout
// survives a process restart (AC5) — the one piece of rate-limiting state in
// this app worth persisting: everything in src/middleware/rate-limit.js and
// the guest-login lockout in src/routes/auth.js is in-memory and
// intentionally forgets on restart (an acceptable trade for a burst-abuse
// throttle), but an in-memory ADMIN lockout would let a restart (a deploy, a
// crash-and-relaunch) silently hand a mid-brute-force attacker a fresh
// counter against the one credential that actually matters.
//
// DISTINCT FROM src/middleware/rate-limit.js: this is not a request-rate
// limiter at all — there is deliberately NO rate limiter on POST
// /admin/login (see that route's own comment for why: a pre-auth per-IP
// limiter would also throttle the real admin's correct password once
// tripped, and at the venue, admin and attacker can share one NAT IP). This
// module is the actual brute-force control on that route.
//
// The handler control flow this module supports is unchanged from issue #49:
// bcrypt.compare runs FIRST, unconditionally; recordFailure()/clear() are
// called only from the wrong-password / success branches respectively —
// src/routes/auth.js owns that control flow, this module owns only the
// counter state.

'use strict';

const { db } = require('../db');
const config = require('../../config');

const KEY_FAILED_ATTEMPTS = 'admin_lockout_failed_attempts';
const KEY_LOCKED_UNTIL = 'admin_lockout_locked_until';

function readInt(key, fallback) {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key);
  if (!row) return fallback;
  const n = parseInt(row.value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function writeInt(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, String(value));
}

/**
 * Current lockout state: how many consecutive wrong passwords have been
 * recorded since the last success/clear, and the timestamp (ms epoch) the
 * active lockout expires at (0 = not locked).
 * @returns {{ failedAttempts: number, lockedUntil: number }}
 */
function getState() {
  return {
    failedAttempts: readInt(KEY_FAILED_ATTEMPTS, 0),
    lockedUntil: readInt(KEY_LOCKED_UNTIL, 0),
  };
}

/**
 * Record one wrong-password attempt. Engages the lockout (sets lockedUntil
 * config.ADMIN_LOGIN_LOCKOUT_MS into the future and resets the counter to 0)
 * once failedAttempts reaches config.ADMIN_LOGIN_MAX_ATTEMPTS — the exact
 * threshold behavior the pre-#283 module-scoped counters implemented.
 * @param {number} [now=Date.now()] - injectable clock for deterministic tests.
 * @returns {{ failedAttempts: number, lockedUntil: number }} state after this failure.
 */
function recordFailure(now = Date.now()) {
  const attempts = readInt(KEY_FAILED_ATTEMPTS, 0) + 1;
  if (attempts >= config.ADMIN_LOGIN_MAX_ATTEMPTS) {
    writeInt(KEY_LOCKED_UNTIL, now + config.ADMIN_LOGIN_LOCKOUT_MS);
    writeInt(KEY_FAILED_ATTEMPTS, 0);
  } else {
    writeInt(KEY_FAILED_ATTEMPTS, attempts);
  }
  return getState();
}

/**
 * Clear the lockout: a correct password always wins (issue #49) — called
 * from the success branch of POST /admin/login regardless of whether a
 * lockout was currently active.
 */
function clear() {
  writeInt(KEY_FAILED_ATTEMPTS, 0);
  writeInt(KEY_LOCKED_UNTIL, 0);
}

module.exports = { getState, recordFailure, clear };
