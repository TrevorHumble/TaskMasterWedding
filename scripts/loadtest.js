// scripts/loadtest.js
//
// Local peak-load harness for Goal A ("fast and standing with the whole guest
// list on it at once, on venue wifi"). Drives a running, event-seeded
// instance (scripts/seed-event.js, issue #166) with a bounded-concurrency
// pool of virtual guests over Node's built-in fetch — NO new dependency.
//
// Each virtual guest:
//   1. Signs in by MINTING the signed gsid cookie directly with node's own
//      `crypto` (see mintSignedGsidCookie below) — no HTTP round trip. Issue
//      #244 retired GET /j/:token (the route this harness used to sign in
//      through, capturing its Set-Cookie); a synthesized "gsid=<token>" is
//      rejected by src/middleware/session.js, since the cookie must be signed
//      exactly the way cookie-parser(COOKIE_SECRET) signs it. This harness
//      reproduces that signing algorithm locally instead (same approach as
//      tests/helpers/testApp.js's signInGuest/signCookieValue), keyed to each
//      lane's seeded token (`${tokenPrefix}${laneIndex}`) — the token itself
//      is never sent over the wire to sign in, only the resulting cookie is.
//      This requires COOKIE_SECRET in this process's env to match the value
//      the target server was started with (both read it from the same
//      project .env by default — see config.js's loadDotEnv).
//   2. Loops over the read paths: /, /tasks, /gallery, /feed, /leaderboard.
//   3. Submits a real photo via POST /tasks/:id/submit (multipart, field
//      "photo") — the heavy path: multer + synchronous better-sqlite3 +
//      sharp thumbnailing, where a blocked event loop would show up first.
//
// Every request is timed and recorded as { ms, status, path, networkFailure }.
// A server 5xx and a client-side network failure (connection refused,
// timeout, reset — no HTTP response at all) are DISTINCT outcomes: only
// networkFailure: true identifies the latter (status is null, never a magic
// status code). summarize() reduces the samples to percentiles + separate
// server5xx / networkFailures counts, both attributed per path; evaluate()
// checks them against a pass bar keyed on server5xx only; the CLI prints a
// summary line and exits non-zero on failure so it is CI/script-friendly
// (though the full run itself needs a live server and is a documented manual
// step — see docs/loadtest.md).
//
// Requiring this module has NO side effects — it only exports the pure
// helpers and the CLI pieces. The CLI runs only under `require.main === module`.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

// ---------------------------------------------------------------------------
// Pure measurement helpers (unit-tested in tests/loadtest.test.js).
// ---------------------------------------------------------------------------

/**
 * Nearest-rank percentile over a copy-sorted array of numbers.
 * Method: sort ascending, then index = ceil(p/100 * n) - 1, clamped to
 * [0, n-1]. This is the classic "nearest rank" definition (no interpolation
 * between neighboring samples), so percentile([...1..100 by 10s], 95) lands
 * exactly on the 10th of 10 sorted values (index 9) and returns 100; p=50
 * lands on index 4 (the 5th value) and returns 50.
 *
 * @param {number[]} samples - latencies in ms (or any numeric samples)
 * @param {number} p - percentile in [0, 100]
 * @returns {number} the value at that percentile; NaN if samples is empty
 */
function percentile(samples, p) {
  if (!Array.isArray(samples) || samples.length === 0) {
    return NaN;
  }
  const sorted = samples.slice().sort((a, b) => a - b); // copy — never mutate the caller's array
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(Math.max(rank, 0), sorted.length - 1);
  return sorted[index];
}

/**
 * Reduce a list of { ms, status, path, networkFailure } samples to summary
 * statistics. Two DISTINCT failure kinds are counted separately, never
 * merged:
 *   - server5xx: the server answered with a real HTTP status >= 500
 *     (networkFailure is falsy and status is a number >= 500). Client 4xx is
 *     not counted here, since the harness's own bad requests should not be
 *     conflated with server breakage under load.
 *   - networkFailures: no HTTP response was received at all (connection
 *     refused, timeout, reset) — identified ONLY by networkFailure === true,
 *     never by a status value (status is null for these samples).
 * Each failing sample is also attributed to its request path in `byPath`, so
 * a caller can see WHERE the run broke, not just how much.
 *
 * @param {Array<{ms: number, status: number|null, path: string, networkFailure: boolean}>} samples
 * @param {number} [durationSec] - wall-clock duration the samples were
 *   collected over, for requests-per-second. Defaults to the sum of sample
 *   latencies converted to seconds if omitted (a reasonable fallback for
 *   pure unit tests that don't run a real timed harness).
 * @returns {{count: number, server5xx: number, networkFailures: number, byPath: Object<string, {server5xx: number, networkFailures: number}>, p50: number, p95: number, p99: number, rps: number}}
 */
function summarize(samples, durationSec) {
  const count = samples.length;
  let server5xx = 0;
  let networkFailures = 0;
  const byPath = {};
  const latencies = [];

  for (const s of samples) {
    latencies.push(s.ms);

    const isServer5xx = !s.networkFailure && typeof s.status === 'number' && s.status >= 500;
    const isNetworkFailure = s.networkFailure === true;

    if (isServer5xx) server5xx += 1;
    if (isNetworkFailure) networkFailures += 1;

    if (isServer5xx || isNetworkFailure) {
      const p = s.path || 'unknown';
      if (!byPath[p]) byPath[p] = { server5xx: 0, networkFailures: 0 };
      if (isServer5xx) byPath[p].server5xx += 1;
      if (isNetworkFailure) byPath[p].networkFailures += 1;
    }
  }

  const effectiveDuration =
    durationSec !== undefined && durationSec > 0
      ? durationSec
      : latencies.reduce((sum, ms) => sum + ms, 0) / 1000;

  return {
    count,
    server5xx,
    networkFailures,
    byPath,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    rps: effectiveDuration > 0 ? count / effectiveDuration : 0,
  };
}

/**
 * Gate a summary against a pass bar. Pass requires BOTH:
 *   - server5xx === 0 (zero real server errors across the whole run)
 *   - p95 <= thresholds.p95Ms
 * networkFailures are reported but never, by themselves, fail the run — a
 * client-side connection drop is harness/network noise, not proof the app
 * broke. Any violated bar produces a human-readable reason so a failing
 * run's printed summary explains why; the server-error reason names
 * `server5xx` explicitly.
 *
 * @param {{server5xx: number, count: number, p95: number}} summary
 * @param {{p95Ms: number}} thresholds
 * @returns {{pass: boolean, reasons: string[]}}
 */
function evaluate(summary, thresholds) {
  const reasons = [];

  if (summary.server5xx > 0) {
    reasons.push(
      `server5xx ${summary.server5xx} > 0 (${summary.server5xx}/${summary.count} requests returned a real server 5xx)`
    );
  }
  if (summary.p95 > thresholds.p95Ms) {
    reasons.push(`p95 ${summary.p95}ms > threshold ${thresholds.p95Ms}ms`);
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Format a summary (from summarize()) into the printed CLI line, including a
 * per-path breakdown for any path that had at least one failure.
 *
 * @param {ReturnType<typeof summarize>} summary
 * @returns {string} e.g.
 *   "Summary: count=10 server5xx=1 networkFailures=1 p50=5ms p95=5ms p99=5ms rps=200.0\n" +
 *   "  /tasks/1/submit: server5xx=1\n" +
 *   "  /gallery: networkFailures=1"
 */
function formatSummary(summary) {
  const headline =
    `Summary: count=${summary.count} server5xx=${summary.server5xx} ` +
    `networkFailures=${summary.networkFailures} p50=${summary.p50}ms p95=${summary.p95}ms ` +
    `p99=${summary.p99}ms rps=${summary.rps.toFixed(1)}`;

  const pathLines = Object.keys(summary.byPath || {})
    .sort()
    .map((p) => {
      const counts = summary.byPath[p];
      const parts = [];
      if (counts.server5xx > 0) parts.push(`server5xx=${counts.server5xx}`);
      if (counts.networkFailures > 0) parts.push(`networkFailures=${counts.networkFailures}`);
      return `  ${p}: ${parts.join(' ')}`;
    });

  return pathLines.length === 0 ? headline : `${headline}\n${pathLines.join('\n')}`;
}

// ---------------------------------------------------------------------------
// CLI-only pieces below. Nothing above this line performs I/O.
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = { p95Ms: 2000 };

/**
 * Parse CLI flags into an options object with documented defaults.
 * @param {string[]} argv - e.g. process.argv.slice(2)
 * @returns {{baseUrl: string, concurrency: number, durationSec: number|null, requests: number|null, tokenPrefix: string}}
 */
function parseArgs(argv) {
  const opts = {
    baseUrl: 'http://localhost:3000',
    concurrency: 100,
    durationSec: null,
    requests: null,
    tokenPrefix: 'event-guest-token-',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--base-url') {
      opts.baseUrl = argv[++i];
    } else if (arg === '--concurrency') {
      opts.concurrency = parseInt(argv[++i], 10);
    } else if (arg === '--duration') {
      opts.durationSec = parseInt(argv[++i], 10);
    } else if (arg === '--requests') {
      opts.requests = parseInt(argv[++i], 10);
    } else if (arg === '--token-prefix') {
      opts.tokenPrefix = argv[++i];
    } else {
      throw new Error(`Unknown argument "${arg}"`);
    }
  }

  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error(`--concurrency must be a positive integer, got "${opts.concurrency}"`);
  }
  if (opts.durationSec === null && opts.requests === null) {
    opts.durationSec = 30; // default run length when neither flag is given
  }

  return opts;
}

/**
 * Extract the `gsid=...` pair from a Set-Cookie response header, ignoring
 * cookie attributes (Path, HttpOnly, SameSite, Expires, ...). Returns null if
 * no gsid cookie is present.
 *
 * The cookie is SIGNED by cookie-parser(COOKIE_SECRET) — its value is not the
 * bare guest token but "s:<token>.<hmac>", URL-encoded.
 *
 * NOT used by this harness's own sign-in anymore (see mintSignedGsidCookie
 * below) — issue #244 retired the GET /j/:token response this used to parse a
 * Set-Cookie header out of. Kept as a general-purpose parsing helper (and its
 * own unit test in tests/loadtest.test.js still covers it) in case a future
 * flow signs in over a real HTTP round trip again.
 *
 * @param {string|null} setCookieHeader - raw Set-Cookie header value
 * @returns {string|null} e.g. "gsid=s%3Aevent-guest-token-0.abc123"
 */
function captureSignedCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  // Match just the gsid= pair, stopping at the first attribute separator (`;`).
  const match = setCookieHeader.match(/gsid=[^;]+/);
  return match ? match[0] : null;
}

/**
 * Sign a raw cookie value exactly the way `cookie-parser` (via the
 * `cookie-signature` package) verifies it: `value + '.' + base64(HMAC-SHA256(
 * value, secret))`, trailing `=` padding stripped. Reproduces
 * cookie-signature's two-line algorithm with node's own `crypto` rather than
 * pulling in that transitive dependency directly — the SAME approach
 * tests/helpers/testApp.js's signCookieValue uses (kept as two small,
 * independent copies rather than a shared module, since one lives under
 * scripts/ and the other under tests/helpers/ with no existing shared home
 * between them).
 *
 * @param {string} value - the raw cookie value (here, a guest's token).
 * @param {string} secret - config.COOKIE_SECRET.
 * @returns {string} the signed value, WITHOUT the leading `s:` marker.
 */
function signCookieValue(value, secret) {
  const mac = crypto.createHmac('sha256', secret).update(value).digest('base64').replace(/=+$/, '');
  return `${value}.${mac}`;
}

/**
 * Mint the exact signed `gsid` cookie header value src/middleware/session.js
 * (via cookie-parser(COOKIE_SECRET)) expects for a given guest token — with
 * NO HTTP round trip. Issue #244 retired GET /j/:token, the route this
 * harness used to sign in through by capturing a real Set-Cookie response; a
 * virtual guest's token is already known here (`${tokenPrefix}${laneIndex}`,
 * matching how scripts/seed-event.js seeds guests), so minting locally is
 * both simpler and removes one HTTP request per lane from the run.
 *
 * Requires this process's COOKIE_SECRET to match the target server's (both
 * default to reading the same project .env — see config.js's loadDotEnv) —
 * otherwise the server rejects the signature and treats the guest as signed
 * out, which would show up as every read path 302-redirecting to /join
 * instead of 200ing.
 *
 * @param {string} token - a guest's `guests.token` value, already seeded.
 * @returns {string} e.g. "gsid=s%3Aevent-guest-token-0.abc123"
 */
function mintSignedGsidCookie(token) {
  const signed = signCookieValue(token, config.COOKIE_SECRET);
  // The cookie's value on the wire is percent-encoded (Express/`cookie`
  // encodes with encodeURIComponent by default) — reproduce that here so it
  // decodes back to the same signed value cookie-parser would unsign from a
  // real Set-Cookie response.
  return `gsid=${encodeURIComponent(`s:${signed}`)}`;
}

/**
 * Bounded-concurrency pool: run `worker` repeatedly, never more than `limit`
 * invocations in flight at once, until `shouldStop()` returns true. Each
 * worker call is independent (a "lap" for one virtual guest); the pool keeps
 * launching new laps into any free slot until told to stop, then waits for
 * in-flight laps to finish.
 *
 * @param {number} limit - max concurrent workers
 * @param {() => boolean} shouldStop - checked before each new lap is started
 * @param {(laneIndex: number) => Promise<void>} worker - one unit of work;
 *   laneIndex (0..limit-1) is stable per lane for the life of the pool, so a
 *   worker can reuse the same virtual-guest identity (token/cookie) across laps.
 * @returns {Promise<void>} resolves once no lane has more work to start and
 *   all in-flight laps have completed
 */
async function runPool(limit, shouldStop, worker) {
  const lanes = [];
  for (let lane = 0; lane < limit; lane++) {
    lanes.push(
      (async () => {
        while (!shouldStop()) {
          await worker(lane);
        }
      })()
    );
  }
  await Promise.all(lanes);
}

/**
 * Perform one HTTP request and record { ms, status, path, networkFailure }.
 * Never throws: a network-level failure (connection refused, timeout, DNS)
 * pushes a sample with `networkFailure: true` and `status: null` — no HTTP
 * status was ever received, so none is fabricated. A real response (any
 * status, including a 5xx) pushes `networkFailure: false` with its actual
 * status.
 *
 * @param {Array<{ms:number,status:number|null,path:string,networkFailure:boolean}>} samples - pushed into in place
 * @param {string} url - the full URL fetched
 * @param {string} requestPath - a stable label for this request (the route
 *   shape, e.g. '/tasks/:id/submit', rather than the per-guest expanded URL,
 *   so the byPath breakdown groups all lanes' hits to the same route)
 * @param {object} [fetchOpts]
 * @returns {Promise<Response|null>} the Response, or null on network failure
 */
async function timedFetch(samples, url, requestPath, fetchOpts) {
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', ...fetchOpts });
    const ms = Date.now() - start;
    // A redirect (e.g. /j/:token -> /onboard or /) is a successful response
    // from the server's point of view — record its actual status, not an error.
    samples.push({ ms, status: res.status, path: requestPath, networkFailure: false });
    return res;
  } catch (_err) {
    const ms = Date.now() - start;
    // Network-level failure — the server did not answer at all. No status
    // was received, so status is null; networkFailure: true is the ONLY
    // signal that identifies this as a connection-level drop, never a status code.
    samples.push({ ms, status: null, path: requestPath, networkFailure: true });
    return null;
  }
}

/**
 * Parse the ACTIVE tasks out of the rendered GET /tasks HTML.
 *
 * The /tasks page (src/views/tasks.ejs) lists ONLY active tasks (guest.js's
 * query filters `WHERE t.is_active = 1`), one per row:
 *   <li class="task-row task-done|task-todo">
 *     <a class="task-link" href="/tasks/<id>"> ... </a>
 *   </li>
 * We match each row's class (done vs todo) together with its task-link id, so
 * a caller can prefer a task the guest has NOT completed (a to-do task, whose
 * submit truly inserts a new row + generates a thumbnail — the heavy path —
 * rather than replacing an existing one). NOTE (#250): the default view shows
 * every to-do row but only the 3 most recent done rows — fine here, since the
 * harness prefers a to-do task anyway.
 *
 * @param {string} html - the GET /tasks response body
 * @returns {Array<{id: number, done: boolean}>} active tasks in page order;
 *   empty if none could be parsed
 */
function extractActiveTaskIds(html) {
  if (typeof html !== 'string') return [];
  const tasks = [];
  // One match per task row: capture the done/todo state class and the
  // task-link's numeric id. `[\s\S]*?` (non-greedy) spans the row's inner
  // markup between the <li> open tag and its task-link href.
  const rowRe =
    /class="task-row (task-done|task-todo)"[\s\S]*?class="task-link"\s+href="\/tasks\/(\d+)"/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    tasks.push({ id: Number(m[2]), done: m[1] === 'task-done' });
  }
  return tasks;
}

/**
 * Choose a task id to submit against from parsed active tasks, preferring one
 * the guest has NOT completed (so the submit inserts + thumbnails, exercising
 * the full heavy path). Falls back to the first active task if all are done,
 * or null if there are no active tasks at all.
 *
 * @param {Array<{id: number, done: boolean}>} tasks
 * @returns {number|null}
 */
function chooseTaskId(tasks) {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;
  const todo = tasks.find((t) => !t.done);
  return (todo || tasks[0]).id;
}

/**
 * Load one real sample image from fixtures/sample-photos as upload bytes.
 * @returns {{buffer: Buffer, filename: string, contentType: string}}
 */
function loadSamplePhoto() {
  const dir = path.join(__dirname, '..', 'fixtures', 'sample-photos');
  const filename = 'sample-01.jpg';
  const buffer = fs.readFileSync(path.join(dir, filename));
  return { buffer, filename, contentType: 'image/jpeg' };
}

/**
 * Run one virtual guest's full lap: sign in (first lap only — the cookie is
 * cached per lane after that), then hit the read paths, then submit a photo.
 *
 * @param {object} ctx
 * @param {string} ctx.baseUrl
 * @param {string} ctx.tokenPrefix
 * @param {Array<{ms:number,status:number|null,path:string,networkFailure:boolean}>} ctx.samples
 * @param {Map<number, string>} ctx.cookies - lane -> minted gsid cookie
 * @param {Map<number, number>} ctx.taskIds - lane -> discovered active task id
 * @param {{buffer: Buffer, filename: string, contentType: string}} ctx.photo
 * @param {{warned: boolean}} ctx.noTaskWarning - one-shot "no active task" warning latch
 * @param {number} laneIndex - stable virtual-guest identity for this lane
 * @returns {Promise<void>}
 */
async function runOneLap(ctx, laneIndex) {
  const { baseUrl, tokenPrefix, samples, cookies, taskIds, photo, noTaskWarning } = ctx;

  let cookie = cookies.get(laneIndex);
  if (!cookie) {
    // Mint the signed session cookie directly (no HTTP round trip) — see
    // mintSignedGsidCookie's doc comment above for why (issue #244 retired
    // the GET /j/:token response this used to sign in through).
    const token = `${tokenPrefix}${laneIndex}`;
    cookie = mintSignedGsidCookie(token);
    cookies.set(laneIndex, cookie);
  }

  const headers = { cookie };

  await timedFetch(samples, `${baseUrl}/`, '/', { headers });

  // GET /tasks — read the body so we can discover a real ACTIVE task id from
  // the rendered markup (see extractActiveTaskIds). Cache the choice per lane
  // so we only parse once; later laps reuse it.
  const tasksRes = await timedFetch(samples, `${baseUrl}/tasks`, '/tasks', { headers });
  let taskId = taskIds.get(laneIndex);
  if (taskId === undefined && tasksRes) {
    let html;
    try {
      html = await tasksRes.text();
    } catch (_err) {
      html = '';
    }
    const chosen = chooseTaskId(extractActiveTaskIds(html));
    if (chosen !== null) {
      taskId = chosen;
      taskIds.set(laneIndex, taskId);
    }
  }

  await timedFetch(samples, `${baseUrl}/gallery`, '/gallery', { headers });
  await timedFetch(samples, `${baseUrl}/feed`, '/feed', { headers });
  await timedFetch(samples, `${baseUrl}/leaderboard`, '/leaderboard', { headers });

  // Only submit when we found a genuinely active task — otherwise the POST
  // would 404 (task_inactive) and skip the sharp+DB heavy path entirely,
  // defeating the point of the load test. Warn once if discovery ever fails.
  if (taskId === undefined) {
    if (!noTaskWarning.warned) {
      noTaskWarning.warned = true;
      console.warn(
        'WARNING: could not find an active task on GET /tasks — the upload heavy path ' +
          'is being SKIPPED. Seed the event first (node scripts/seed-event.js) so there ' +
          'are active tasks to submit against.'
      );
    }
    return;
  }

  const form = new FormData();
  form.append('photo', new Blob([photo.buffer], { type: photo.contentType }), photo.filename);
  await timedFetch(samples, `${baseUrl}/tasks/${taskId}/submit`, '/tasks/:id/submit', {
    method: 'POST',
    headers,
    body: form,
  });
}

/**
 * Run the full load test: bounded-concurrency pool of virtual guests against
 * a live server, for either a fixed duration or a fixed request count.
 *
 * @param {{baseUrl: string, concurrency: number, durationSec: number|null, requests: number|null, tokenPrefix: string}} opts
 * @returns {Promise<{samples: Array<{ms:number,status:number|null,path:string,networkFailure:boolean}>, durationSec: number}>}
 */
async function runLoadTest(opts) {
  const samples = [];
  const cookies = new Map();
  const taskIds = new Map();
  const noTaskWarning = { warned: false };
  const photo = loadSamplePhoto();
  const ctx = {
    baseUrl: opts.baseUrl,
    tokenPrefix: opts.tokenPrefix,
    samples,
    cookies,
    taskIds,
    photo,
    noTaskWarning,
  };

  const start = Date.now();
  let shouldStop;
  if (opts.requests !== null) {
    shouldStop = () => samples.length >= opts.requests;
  } else {
    const deadline = start + opts.durationSec * 1000;
    shouldStop = () => Date.now() >= deadline;
  }

  await runPool(opts.concurrency, shouldStop, (laneIndex) => runOneLap(ctx, laneIndex));

  const durationSec = (Date.now() - start) / 1000;
  return { samples, durationSec };
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

  console.log(
    `Load test starting: baseUrl=${opts.baseUrl} concurrency=${opts.concurrency} ` +
      (opts.requests !== null ? `requests=${opts.requests}` : `duration=${opts.durationSec}s`)
  );

  const { samples, durationSec } = await runLoadTest(opts);
  const summary = summarize(samples, durationSec);
  const result = evaluate(summary, DEFAULT_THRESHOLDS);

  console.log(formatSummary(summary));

  if (result.pass) {
    console.log('PASS: within Goal A thresholds.');
  } else {
    console.log('FAIL:');
    result.reasons.forEach((reason) => console.log(`  - ${reason}`));
  }

  process.exit(result.pass ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  percentile,
  summarize,
  evaluate,
  formatSummary,
  parseArgs,
  captureSignedCookie,
  signCookieValue,
  mintSignedGsidCookie,
  extractActiveTaskIds,
  chooseTaskId,
  runPool,
  runLoadTest,
  DEFAULT_THRESHOLDS,
};
