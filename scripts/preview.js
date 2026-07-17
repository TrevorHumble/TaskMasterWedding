// scripts/preview.js
//
// Issue #378 — "settle the look live": boots the app on a throwaway, seeded
// database and hands back one localhost link the owner can open and refresh
// while the orchestrator edits the real `src/views/**` / `src/public/**` in
// this worktree. Nothing about the printed link, the scratch DATA_DIR, or the
// picked port ever touches a real event's data (AC2).
//
// Deliberately kept in scripts/, not tools/ — tools/ is on the frozen
// governing-artifact surface (CLAUDE.md § "Governance freeze"), so keeping
// this launcher in scripts/ keeps it cheap to change (per the issue's
// implementation plan step 1).
//
// Mechanism, reusing existing prior art rather than reinventing it:
//   - Scratch DATA_DIR + free port + seed-as-a-child-process: the same shape
//     as scripts/smoke.js's boot/free-port/seed harness, but this script stays
//     up and hands the owner an interactive link instead of probing and exiting.
//   - Boots the worktree's own src/app.js as a CHILD PROCESS with DATA_DIR /
//     DB_PATH / PORT overridden in its env — the same pattern
//     scripts/serve-resilient.js uses to launch `node src/app.js`. A child
//     process (rather than an in-process require) keeps this script's own
//     module cache (and any "real" config a caller may have already loaded)
//     completely isolated from the previewed app's config.
//   - Seeding delegates to scripts/seed-story.js (#450) — this script does not
//     duplicate seeding logic, only drives it with a scratch DATA_DIR.
//   - Real photos: scripts/sample-photo-pool.js already reads
//     config.LOCAL_PHOTOS_DIR with a graceful fallback to the bundled CC0
//     sample pool when it is unset — that env var is inherited automatically
//     by the seeding child (via `...process.env`), so a caller who has
//     LOCAL_PHOTOS_DIR set in their shell gets real photos in the preview with
//     no extra flag; a caller who has not gets the bundled placeholders,
//     silently and correctly, with no separate "fallback mode" to opt into.
//
// View caching: Express only enables the view cache when NODE_ENV is exactly
// 'production' (Express's own default behavior). The spawned app child's
// NODE_ENV is explicitly forced to 'development' below (never inherited from
// a caller's shell) specifically so an edited src/views/**/*.ejs file is
// re-read from disk on the very next refresh, with no restart — the whole
// point of a live phase-1 loop (see agents/orchestrator.md § "Visual-approval
// loop").
//
// Requiring this module has NO side effects beyond exporting `startPreview`
// and the small pure helpers below. The interactive run (spawn a child,
// print a URL, wait for Ctrl+C) happens only when this file is executed
// directly: `node scripts/preview.js` / `npm run preview`.
'use strict';

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const APP_ENTRY = path.join(REPO_ROOT, 'src', 'app.js');
const SEED_STORY_SCRIPT = path.join(REPO_ROOT, 'scripts', 'seed-story.js');
const { STORIES } = require('./seed-story');

const DEFAULT_STORY = 'normal';
const READY_TIMEOUT_MS = 20000;
const READY_POLL_INTERVAL_MS = 200;

/**
 * Throw unless `story` is a key of STORIES. Single owner of that check and
 * its error message — parseArgs (CLI validation) and startPreview (the same
 * validation for programmatic callers that bypass parseArgs) both call this
 * rather than each re-stating the check and the string.
 * @param {string} story
 */
function assertKnownStory(story) {
  if (!Object.prototype.hasOwnProperty.call(STORIES, story)) {
    throw new Error(
      `--story must be one of: ${Object.keys(STORIES).join(', ')} (got ${JSON.stringify(story)})`
    );
  }
}

/**
 * Parse `--port <n>` and `--story <name>` from an argv-style array. Throws on
 * a non-positive-integer --port, an unknown --story, or an unrecognized flag,
 * so a typo'd CLI invocation fails loudly instead of silently seeding the
 * wrong story or racing an invalid port through to child_process.spawn.
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{ port: number|undefined, story: string }}
 */
function parseArgs(argv) {
  let port;
  let story = DEFAULT_STORY;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port') {
      const raw = argv[++i];
      const value = Number(raw);
      if (raw === undefined || !Number.isInteger(value) || value <= 0) {
        throw new Error(`--port requires a positive integer, got ${JSON.stringify(raw)}`);
      }
      port = value;
    } else if (arg === '--story') {
      story = argv[++i];
    } else {
      throw new Error(
        `Unknown argument "${arg}". Usage: preview.js [--port N] [--story ${Object.keys(STORIES).join('|')}]`
      );
    }
  }

  assertKnownStory(story);

  return { port, story };
}

/**
 * Ask the OS for a currently-free TCP port by binding to port 0, reading back
 * what the OS assigned, then releasing it. There is an inherent, accepted
 * TOCTOU race between the close() here and the app child's own bind a few
 * lines later (another process could in principle grab the same port in
 * between) — the same tradeoff every "ask the OS for a free port, then hand
 * it to a child process" dev-tool pattern accepts, and is fine for a
 * throwaway interactive preview.
 * @returns {Promise<number>}
 */
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Run scripts/seed-story.js as a child process against `dataDir`, the same
 * "seed as a child so it reads its own fresh config" shape scripts/smoke.js
 * uses for scripts/seed-event.js. Throws with the child's stderr attached on
 * a non-zero exit so a seeding failure surfaces immediately instead of
 * leaving the caller to guess why the app child booted an empty database.
 * @param {string} dataDir
 * @param {string} story
 */
function seedScratchDataDir(dataDir, story) {
  const res = spawnSync(process.execPath, [SEED_STORY_SCRIPT, '--story', story], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'app.db'),
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  if (res.status !== 0) {
    throw new Error(
      `scripts/seed-story.js --story ${story} failed (exit ${res.status}): ` +
        `${String(res.stderr || res.error || '').slice(0, 2000)}`
    );
  }
}

/**
 * Poll `${url}/healthz` until it returns 200 or `timeoutMs` elapses. Also
 * bails immediately (without waiting out the timeout) if `child` has already
 * exited, since a crashed app will never become ready.
 * @param {string} url
 * @param {import('child_process').ChildProcess} child
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
async function waitUntilReady(url, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `app process exited before becoming ready (code=${child.exitCode}, signal=${child.signalCode})`
      );
    }
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }

  throw new Error(
    `app did not report healthy within ${timeoutMs}ms at ${url}/healthz` +
      (lastErr ? ` (last error: ${lastErr.message})` : '')
  );
}

/**
 * Start one preview instance: seed a scratch DATA_DIR with a named story,
 * boot the worktree's own src/app.js as a child process bound to a free port,
 * and wait for it to report healthy.
 *
 * @param {{ port?: number, story?: string }} [opts]
 * @returns {Promise<{
 *   url: string,
 *   port: number,
 *   dataDir: string,
 *   dbPath: string,
 *   child: import('child_process').ChildProcess,
 *   stop: () => Promise<{ code: number|null, signal: string|null }>,
 * }>}
 */
async function startPreview(opts = {}) {
  const story = opts.story || DEFAULT_STORY;
  assertKnownStory(story);

  // A fresh, uniquely-named directory under the OS temp root every run — by
  // construction this can never equal a real event's DATA_DIR (AC2), with no
  // need to inspect what the "real" DATA_DIR even is.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-preview-'));
  const dbPath = path.join(dataDir, 'app.db');

  seedScratchDataDir(dataDir, story);

  const port = opts.port || (await getFreePort());
  const url = `http://localhost:${port}`;

  const child = spawn(process.execPath, [APP_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_PATH: dbPath,
      PORT: String(port),
      // Force development mode regardless of the caller's shell: keeps
      // Express's view cache off (edited .ejs files re-read on refresh) and
      // keeps cookies non-Secure for plain-HTTP localhost. See file header.
      NODE_ENV: 'development',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  let stderrTail = '';
  child.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-4000);
  });

  try {
    await waitUntilReady(url, child, READY_TIMEOUT_MS);
  } catch (err) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const detail = stderrTail ? ` -- app stderr tail:\n${stderrTail}` : '';
    throw new Error(`${err.message}${detail}`, { cause: err });
  }

  /**
   * Stop the app child, resolving once it has actually exited (so a caller
   * can safely remove `dataDir` right after awaiting this).
   */
  function stop() {
    if (child.exitCode !== null || child.signalCode !== null) {
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }
    return new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.kill();
    });
  }

  return { url, port, dataDir, dbPath, child, stop };
}

module.exports = { startPreview, getFreePort, parseArgs, STORIES, REPO_ROOT };

// ---------------------------------------------------------------------------
// Direct execution only: print exactly one URL line, then stay up until the
// owner kills the process (Ctrl+C), tearing the child down cleanly.
// ---------------------------------------------------------------------------
if (require.main === module) {
  main();
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
    return;
  }

  let preview;
  try {
    preview = await startPreview(opts);
  } catch (err) {
    console.error('[preview] failed to start:', err.message);
    process.exitCode = 1;
    return;
  }

  // Exactly one line of stdout (AC1): the URL, and nothing else — the seed
  // child's and app child's own stdio are never forwarded (see stdio
  // options above), so no other process can add a second line here.
  console.log(preview.url);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await preview.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  preview.child.on('exit', (code) => {
    if (shuttingDown) return;
    console.error(`[preview] app process exited unexpectedly (code=${code})`);
    process.exitCode = code === null ? 1 : code;
  });
}
