// src/utils/shutdown.js
// Graceful shutdown for the HTTP server + SQLite handle (issue #282).
//
// A hosting platform sends SIGTERM before restarting or redeploying the
// process. Without a handler the process dies mid-request -- an in-flight
// photo upload gets cut off and the SQLite WAL file can be left in a state
// that needs recovery on next boot. installShutdownHandlers builds the
// shutdown routine; the caller (src/app.js) registers it against
// process.on('SIGTERM'/'SIGINT') so tests that merely require the app module
// never register real process signal listeners.
'use strict';

/**
 * Build an idempotent shutdown routine bound to one HTTP server and DB handle.
 *
 * The returned `shutdown(signal)` function stops the server from accepting
 * new connections, waits for in-flight requests to finish (server.close's own
 * behavior), closes the database, and exits. A force-exit timer guards
 * against a connection that never drains (e.g. a stalled upload) so the
 * process still exits within `timeoutMs` even if `server.close`'s callback
 * never fires; the timer is unref'd so it never itself keeps the process
 * alive once the clean path already exited.
 *
 * @param {import('http').Server} server - the listening HTTP server to drain
 * @param {object} deps
 * @param {import('better-sqlite3').Database} deps.db - the live DB handle to close
 * @param {(code: number) => void} [deps.exit] - injectable in place of process.exit, for tests
 * @param {number} [deps.timeoutMs] - force-exit backstop if close hangs
 * @param {(...args: any[]) => void} [deps.log] - injectable in place of console.log, for tests
 * @returns {(signal?: string) => void} shutdown - call once per process lifetime; later calls are no-ops
 */
function installShutdownHandlers(
  server,
  { db, exit = process.exit, timeoutMs = 10000, log = console.log }
) {
  let closing = false;

  return function shutdown(signal) {
    // Idempotent: a platform can send both SIGTERM and SIGINT, or the same
    // signal twice, in the middle of a restart. Only the first call runs.
    if (closing) return;
    closing = true;

    log(`[shutdown] received ${signal || 'shutdown'}, draining connections...`);

    // Backstop: if server.close never calls back (a connection that never
    // drains), force-exit after timeoutMs rather than hang the platform's
    // restart forever. unref() so this timer never itself keeps the process
    // alive after the clean path below already exited.
    const forceTimer = setTimeout(() => exit(1), timeoutMs);
    forceTimer.unref();

    server.close(() => {
      if (db && db.open) {
        db.close();
      }
      exit(0);
    });
  };
}

module.exports = { installShutdownHandlers };
