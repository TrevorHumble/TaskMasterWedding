// scripts/serve-resilient.js
// Auto-restart wrapper for the app server.
//
// Usage:
//   node scripts/serve-resilient.js
//
// Spawns `node src/app.js` and relaunches it whenever it exits unexpectedly.
// Stops restarting if 10 or more restarts happen within 60 seconds, to prevent
// a hot crash-loop from pegging the CPU. No new npm dependency — only Node
// built-ins are used.

'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ENTRY = path.join(__dirname, '..', 'src', 'app.js');
const MAX_RESTARTS = 10;
const WINDOW_MS = 60_000;
const BACKOFF_MS = 1_000;

const restartTimes = [];

function launch() {
  const child = spawn(process.execPath, [ENTRY], { stdio: 'inherit' });
  currentChild = child;

  child.on('error', (err) => {
    console.error('[serve-resilient] failed to spawn child process:', err.message);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal === 'SIGINT' || signal === 'SIGTERM') {
      // Clean shutdown — do not restart.
      console.log('[serve-resilient] server exited cleanly, stopping.');
      process.exit(0);
    }

    const now = Date.now();
    // Drop timestamps outside the rolling window.
    while (restartTimes.length > 0 && now - restartTimes[0] > WINDOW_MS) {
      restartTimes.shift();
    }

    if (restartTimes.length >= MAX_RESTARTS) {
      console.error(
        `[serve-resilient] ${MAX_RESTARTS} restarts within ${WINDOW_MS / 1000}s — ` +
          'crash-loop detected; giving up.'
      );
      process.exit(1);
    }

    restartTimes.push(now);
    console.log(
      `[serve-resilient] server exited (code=${code}, signal=${signal}); ` +
        `restarting in ${BACKOFF_MS}ms (restart ${restartTimes.length}/${MAX_RESTARTS} in window)…`
    );
    setTimeout(launch, BACKOFF_MS);
  });
}

// On SIGINT/SIGTERM, forward the signal to the child so it can shut down
// cleanly, then exit the wrapper without restarting.
let currentChild = null;

process.on('SIGINT', () => {
  if (currentChild) currentChild.kill('SIGINT');
  process.exit(0);
});
process.on('SIGTERM', () => {
  if (currentChild) currentChild.kill('SIGTERM');
  process.exit(0);
});

console.log('[serve-resilient] starting', ENTRY);
launch();
