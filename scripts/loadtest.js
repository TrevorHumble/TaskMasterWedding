// scripts/loadtest.js
//
// Local peak-load harness for Goal A ("fast and standing with the whole guest
// list on it at once, on venue wifi"). Drives a running, event-seeded
// instance (scripts/seed-event.js, issue #166) with a bounded-concurrency
// pool of virtual guests over Node's built-in fetch — NO new dependency.
//
// Each virtual guest:
//   1. Signs in via GET /j/<token>, capturing the SIGNED gsid cookie from the
//      response's Set-Cookie header (see captureSignedCookie below — the
//      cookie is signed by cookie-parser(COOKIE_SECRET); synthesizing
//      "gsid=<token>" ourselves would be rejected by src/middleware/session.js).
//   2. Loops over the read paths: /, /tasks, /gallery, /feed, /leaderboard.
//   3. Submits a real photo via POST /tasks/:id/submit (multipart, field
//      "photo") — the heavy path: multer + synchronous better-sqlite3 +
//      sharp thumbnailing, where a blocked event loop would show up first.
//
// Every request is timed and recorded as { ms, status }. summarize() reduces
// the samples to percentiles + error rate; evaluate() checks them against a
// pass bar; the CLI prints a summary line and exits non-zero on failure so it
// is CI/script-friendly (though the full run itself needs a live server and
// is a documented manual step — see docs/loadtest.md).
//
// Requiring this module has NO side effects — it only exports the pure
// helpers and the CLI pieces. The CLI runs only under `require.main === module`.
'use strict';

const fs = require('fs');
const path = require('path');

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
 * Reduce a list of { ms, status } samples to summary statistics.
 * A sample counts as an error when status >= 500 (server-side failure —
 * client 4xx is not counted here, since the harness's own bad requests
 * should not be conflated with server breakage under load).
 *
 * @param {Array<{ms: number, status: number}>} samples
 * @param {number} [durationSec] - wall-clock duration the samples were
 *   collected over, for requests-per-second. Defaults to the sum of sample
 *   latencies converted to seconds if omitted (a reasonable fallback for
 *   pure unit tests that don't run a real timed harness).
 * @returns {{count: number, errors: number, errorRate: number, p50: number, p95: number, p99: number, rps: number}}
 */
function summarize(samples, durationSec) {
  const count = samples.length;
  const errors = samples.filter((s) => s.status >= 500).length;
  const errorRate = count === 0 ? 0 : errors / count;
  const latencies = samples.map((s) => s.ms);

  const effectiveDuration =
    durationSec !== undefined && durationSec > 0
      ? durationSec
      : latencies.reduce((sum, ms) => sum + ms, 0) / 1000;

  return {
    count,
    errors,
    errorRate,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    rps: effectiveDuration > 0 ? count / effectiveDuration : 0,
  };
}

/**
 * Gate a summary against a pass bar. Pass requires BOTH:
 *   - errorRate === 0 (zero 5xx across the whole run)
 *   - p95 <= thresholds.p95Ms
 * Any other combination fails, with a human-readable reason for each
 * violated bar so a failing run's printed summary explains why.
 *
 * @param {{errorRate: number, p95: number}} summary
 * @param {{p95Ms: number}} thresholds
 * @returns {{pass: boolean, reasons: string[]}}
 */
function evaluate(summary, thresholds) {
  const reasons = [];

  if (summary.errorRate > 0) {
    reasons.push(
      `errorRate ${(summary.errorRate * 100).toFixed(1)}% > 0% (${summary.errors}/${summary.count} requests returned 5xx)`
    );
  }
  if (summary.p95 > thresholds.p95Ms) {
    reasons.push(`p95 ${summary.p95}ms > threshold ${thresholds.p95Ms}ms`);
  }

  return { pass: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// CLI-only pieces below. Nothing above this line performs I/O.
// ---------------------------------------------------------------------------

const DEFAULT_THRESHOLDS = { p95Ms: 2000 };

// Single sentinel status for a network-level failure (connection refused,
// timeout, DNS) where the server never sent a real HTTP status. Chosen >= 500
// so summarize()'s `status >= 500` error rule counts it as an error, exactly
// as a real 5xx would. Referred to by this name everywhere it matters.
const NETWORK_FAILURE_STATUS = 599;

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
 * bare guest token but "s:<token>.<hmac>", URL-encoded. We must forward this
 * EXACT value verbatim; synthesizing "gsid=<token>" ourselves fails
 * signature verification in src/middleware/session.js and the guest is
 * treated as signed out.
 *
 * @param {string|null} setCookieHeader - raw Set-Cookie header value
 * @returns {string|null} e.g. "gsid=s%3Aevent-guest-token-0.abc123"
 */
function captureSignedCookie(setCookieHeader) {
  if (!setCookieHeader) return null;
  // Match just the gsid= pair, stopping at the first attribute separator (`;`).
  // auth.js's /j/:token sets exactly one cookie per redirect response, so a
  // single match is all we need — no multi-cookie splitting.
  const match = setCookieHeader.match(/gsid=[^;]+/);
  return match ? match[0] : null;
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
 * Perform one HTTP request and record { ms, status }. Never throws: a
 * network-level failure (connection refused, timeout, DNS) pushes a sample
 * with status NETWORK_FAILURE_STATUS (599) so that summarize()'s
 * `status >= 500` rule counts it as an error, the same as a real 5xx.
 *
 * @param {Array<{ms:number,status:number}>} samples - pushed into in place
 * @param {string} url
 * @param {object} [fetchOpts]
 * @returns {Promise<Response|null>} the Response, or null on network failure
 */
async function timedFetch(samples, url, fetchOpts) {
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: 'manual', ...fetchOpts });
    const ms = Date.now() - start;
    // A redirect (e.g. /j/:token -> /onboard or /) is a successful response
    // from the server's point of view — record its actual status, not an error.
    samples.push({ ms, status: res.status });
    return res;
  } catch (_err) {
    const ms = Date.now() - start;
    // Network-level failure — the server did not answer at all. Record the
    // NETWORK_FAILURE_STATUS sentinel so `status >= 500` still catches it.
    samples.push({ ms, status: NETWORK_FAILURE_STATUS });
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
 * @param {Array<{ms:number,status:number}>} ctx.samples
 * @param {Map<number, string>} ctx.cookies - lane -> captured gsid cookie
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
    const token = `${tokenPrefix}${laneIndex}`;
    const res = await timedFetch(samples, `${baseUrl}/j/${token}`);
    if (res) {
      const captured = captureSignedCookie(res.headers.get('set-cookie'));
      if (captured) {
        cookie = captured;
        cookies.set(laneIndex, cookie);
      }
    }
    if (!cookie) {
      // Could not sign in this lane — nothing more to do this lap.
      return;
    }
  }

  const headers = { cookie };

  await timedFetch(samples, `${baseUrl}/`, { headers });

  // GET /tasks — read the body so we can discover a real ACTIVE task id from
  // the rendered markup (see extractActiveTaskIds). Cache the choice per lane
  // so we only parse once; later laps reuse it.
  const tasksRes = await timedFetch(samples, `${baseUrl}/tasks`, { headers });
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

  await timedFetch(samples, `${baseUrl}/gallery`, { headers });
  await timedFetch(samples, `${baseUrl}/feed`, { headers });
  await timedFetch(samples, `${baseUrl}/leaderboard`, { headers });

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
  await timedFetch(samples, `${baseUrl}/tasks/${taskId}/submit`, {
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
 * @returns {Promise<{samples: Array<{ms:number,status:number}>, durationSec: number}>}
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

  console.log(
    `Summary: count=${summary.count} errors=${summary.errors} errorRate=${(summary.errorRate * 100).toFixed(2)}% ` +
      `p50=${summary.p50}ms p95=${summary.p95}ms p99=${summary.p99}ms rps=${summary.rps.toFixed(1)}`
  );

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
  parseArgs,
  captureSignedCookie,
  extractActiveTaskIds,
  chooseTaskId,
  runPool,
  runLoadTest,
  DEFAULT_THRESHOLDS,
  NETWORK_FAILURE_STATUS,
};
