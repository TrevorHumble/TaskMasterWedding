// scripts/smoke.js
//
// Empirical smoke gate (#197): boots the REAL app against a freshly seeded
// throwaway database and verifies observed behavior — the hot guest paths
// respond, hostile input does not kill the process, and every badge the seeds
// reference has art on disk. The rest of the pipeline verifies provenance (a
// review happened, bound to a tree); this script is the one gate that verifies
// the app itself works. It exits 0 only when every check passes, non-zero with
// the failing checks named.
//
// Usage:
//   node scripts/smoke.js
//
// Requiring this module has NO side effects — it only exports the pure check
// helpers (unit-tested in tests/smoke-harness.test.js). The boot-seed-probe run
// happens only when the script is executed directly.
//
// Design notes:
// - The app runs IN-PROCESS on an ephemeral port (src/app.js exports the app
//   and only listens when run as main). DATA_DIR/DB_PATH env must be set
//   before the first require of config/db/app — same rule as
//   tests/helpers/testApp.js.
// - Seeding runs as CHILD processes (seed-event.js for the live DB the app
//   serves; seed.js into a second temp dir purely to audit its badge catalog),
//   so each seeder reads its own fresh config from env instead of fighting
//   this process's module cache.
// - An unhandledRejection listener is registered before the hostile-input
//   probe. Without it, the exact defect this gate exists to catch (#187: a
//   corrupt avatar upload rejects an un-awaited promise and Node kills the
//   process) would kill the smoke run itself instead of being reported as a
//   named FAIL.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');
const FETCH_TIMEOUT_MS = 10000;

// ---------------------------------------------------------------------------
// Pure helpers (exported; unit-tested without booting anything).
// ---------------------------------------------------------------------------

/**
 * Turn an array of Set-Cookie header strings into a Cookie request-header
 * value: keep each cookie's name=value pair, drop its attributes.
 * @param {string[]} setCookies
 * @returns {string}
 */
function cookieHeaderFrom(setCookies) {
  return (setCookies || [])
    .map((c) => String(c).split(';')[0].trim())
    .filter((c) => c.includes('='))
    .join('; ');
}

/**
 * Given badge rows ({ code, art_path }) and the public dir they resolve
 * against, return the rows whose art file does not exist on disk. A row with
 * an emoji/non-path art value (no leading '/') is skipped — only /-rooted
 * art_paths are files the app will <img src> (custom badges may hold emoji).
 * @param {{code: string, art_path: string|null}[]} rows
 * @param {string} publicDir
 * @returns {{code: string, art_path: string}[]}
 */
function missingBadgeArt(rows, publicDir) {
  return (rows || []).filter((row) => {
    const art = row && row.art_path;
    if (typeof art !== 'string' || !art.startsWith('/')) return false;
    // art_path is URL-shaped ('/badges/bloom.svg'); resolve under publicDir.
    const rel = art.replace(/^\/+/, '').split('/').join(path.sep);
    return !fs.existsSync(path.join(publicDir, rel));
  });
}

/**
 * Render a result list and compute the exit code. Pure: no printing here.
 * @param {{name: string, ok: boolean, detail?: string}[]} results
 * @returns {{lines: string[], exitCode: number}}
 */
function summarize(results) {
  const lines = results.map((r) => {
    const status = r.ok ? 'PASS' : 'FAIL';
    return r.detail ? `${status} ${r.name} — ${r.detail}` : `${status} ${r.name}`;
  });
  const failed = results.filter((r) => !r.ok).length;
  lines.push(
    failed === 0
      ? `smoke: all ${results.length} checks passed`
      : `smoke: ${failed} of ${results.length} checks FAILED`
  );
  return { lines, exitCode: failed === 0 ? 0 : 1 };
}

module.exports = { cookieHeaderFrom, missingBadgeArt, summarize };

// ---------------------------------------------------------------------------
// The run itself (direct execution only).
// ---------------------------------------------------------------------------

/** fetch with a hard timeout so a hung route reads as a FAIL, not a hang. */
function probe(url, options = {}) {
  return fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    ...options,
  });
}

/** Run a seeder script as a child against its own DATA_DIR. */
function runSeeder(script, args, dataDir) {
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, 'scripts', script), ...args], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      DATA_DIR: dataDir,
      DB_PATH: path.join(dataDir, 'app.db'),
    },
    encoding: 'utf8',
    timeout: 120000,
  });
  return res;
}

/**
 * Extract the CSRF double-submit token (issue #284) a rendered page carries,
 * so the smoke run can echo it back on unsafe requests exactly as a browser
 * does. Reads the hidden form field first (partials/csrf-field.ejs), falling
 * back to the <meta name="csrf-token"> tag (partials/head.ejs) for a page with
 * no form. The token is base64url (no HTML-special characters), so a plain
 * attribute-value match is safe.
 * @param {string} html
 * @returns {string}
 */
function tokenFromHtml(html) {
  const s = String(html || '');
  const field = /name="_csrf"\s+value="([^"]*)"/i.exec(s);
  if (field) return field[1];
  const meta = /name="csrf-token"\s+content="([^"]*)"/i.exec(s);
  return meta ? meta[1] : '';
}

async function main() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  };

  // Track the #187 failure mode: an async route handler whose rejection
  // escapes Express. In production Node kills the process; here the listener
  // converts that outage into a named FAIL and lets the run finish reporting.
  const unhandled = [];
  process.on('unhandledRejection', (err) => {
    unhandled.push(err instanceof Error ? err.message : String(err));
  });

  // 1. Fresh throwaway data dir; env BEFORE any config/db/app require.
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-smoke-'));
  process.env.DATA_DIR = dataDir;
  process.env.DB_PATH = path.join(dataDir, 'app.db');

  // 2. Seed the event fixture the app will serve.
  const seedRes = runSeeder('seed-event.js', ['--guests', '8', '--seed', '1'], dataDir);
  check(
    'seed-event boots a fixture DB',
    seedRes.status === 0,
    `seed-event.js exited ${seedRes.status}: ${String(seedRes.stderr || '').slice(0, 400)}`
  );
  if (seedRes.status !== 0) return finish(results, null);

  // 3. Boot the real app in-process on an ephemeral port.
  const app = require('../src/app');
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1');
    s.once('listening', () => resolve(s));
    s.once('error', reject);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  check('app boots and listens', true);

  try {
    // 4. Hot paths.
    const adminLogin = await probe(`${base}/admin/login`);
    check('GET /admin/login → 200', adminLogin.status === 200, `got ${adminLogin.status}`);

    // A real seeded guest row, straight from the DB the app is serving — this
    // just audits that seed-event.js actually produced guests; sign-in itself
    // (below) no longer depends on any particular seeded token (issue #244
    // retired GET /j/:token, the route this used to sign in through).
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH, { readonly: true });
    const guestRow = db.prepare('SELECT token FROM guests ORDER BY id LIMIT 1').get();
    const badgeRows = db.prepare('SELECT code, art_path FROM badges').all();
    db.close();
    check('seed produced at least one guest', Boolean(guestRow), 'guests table is empty');
    if (!guestRow) return finish(results, server);

    // 4. Sign in the real current way: POST /join with a name + contact + PIN
    //    (no avatar) and capture the gsid cookie from the response's
    //    Set-Cookie header — the actual signup path every guest now uses
    //    (issue #240), exercised here end-to-end rather than mocked.
    //
    //    CSRF (issue #284): every unsafe request now needs the double-submit
    //    token. GET /join first to obtain the signed `csrf` cookie and the
    //    token the form carries, then echo that token back on the POST (as the
    //    `_csrf` body field) while sending the csrf cookie — exactly what a
    //    browser does. Without the token the app correctly 403s the POST.
    const joinForm = await probe(`${base}/join`);
    const csrfCookie = cookieHeaderFrom(joinForm.headers.getSetCookie());
    const csrfToken = tokenFromHtml(await joinForm.text());
    check(
      'GET /join issues a csrf token',
      Boolean(csrfToken) && csrfCookie.includes('csrf='),
      `token '${String(csrfToken).slice(0, 8)}...', cookie '${csrfCookie}'`
    );

    const joinRes = await probe(`${base}/join`, {
      method: 'POST',
      headers: { cookie: csrfCookie },
      body: new URLSearchParams({
        name: 'Smoke Test Guest',
        contact: `smoke-${Date.now()}@example.com`,
        pin: '1234',
        _csrf: csrfToken,
      }),
    });
    // Carry BOTH the csrf cookie (issued on GET /join, and NOT re-sent on the
    // POST response since it arrived already present) and the fresh gsid
    // onward, so every authenticated request below is also CSRF-valid.
    const cookie = [csrfCookie, cookieHeaderFrom(joinRes.headers.getSetCookie())]
      .filter(Boolean)
      .join('; ');
    check(
      'POST /join signs in (302 + gsid cookie)',
      joinRes.status === 302 && cookie.includes('gsid='),
      `status ${joinRes.status}, cookie '${cookie}'`
    );

    for (const p of ['/', '/gallery', '/leaderboard', '/feed']) {
      const res = await probe(`${base}${p}`, { headers: { cookie } });
      check(`GET ${p} (signed-in) → 200`, res.status === 200, `got ${res.status}`);
    }

    // 5. Hostile input: a non-image posted as an avatar (#187's regression).
    //    POST /join itself deliberately does NOT reject a bad avatar (it
    //    drops it and 302s home — a #240 design choice), so that route no
    //    longer exercises this regression. POST /me/edit (profile avatar
    //    edit — still requires the session established above) is the
    //    surviving avatar-intake route that actually tries to decode the
    //    bytes (photos.saveAvatar), so it is what we probe here. Its real
    //    behavior on a bad avatar is a flash + 302 back to /me/edit (NOT a
    //    4xx render) — assert that actual status, not a guessed one. What
    //    matters for #187 is that the corrupt decode failure is caught
    //    (guest.js's try/catch around saveAvatar) instead of escaping as an
    //    unhandled rejection that kills the process.
    const form = new FormData();
    form.append('name', 'Smoke Test Guest');
    // CSRF token as the multipart _csrf field (issue #284): /me/edit is a
    // dedicated upload route, so its token is verified post-multer off this
    // parsed field. The cookie above already carries the matching csrf cookie.
    form.append('_csrf', csrfToken);
    form.append(
      'avatar',
      new Blob([Buffer.from('this is not a real jpeg')], { type: 'image/jpeg' }),
      'corrupt.jpg'
    );
    let hostileDetail = '';
    let hostileOk = false;
    try {
      const hostile = await probe(`${base}/me/edit`, {
        method: 'POST',
        headers: { cookie },
        body: form,
      });
      hostileOk = hostile.status === 302 && hostile.headers.get('location') === '/me/edit';
      hostileDetail = `got ${hostile.status} location=${hostile.headers.get('location')} (want 302 -> /me/edit)`;
    } catch (err) {
      hostileDetail = `no response (${err.name}) — handler died mid-request`;
    }
    // Give a rejected-after-response promise a beat to surface.
    await new Promise((r) => setTimeout(r, 250));
    if (unhandled.length > 0) {
      hostileOk = false;
      hostileDetail += `; unhandled rejection: ${unhandled[0]}`;
    }
    const alive = await probe(`${base}/`, { headers: { cookie } }).then(
      (r) => r.status === 200,
      () => false
    );
    check(
      'hostile avatar upload to /me/edit → 302 (caught, not crashed), no unhandled rejection, server alive',
      hostileOk && alive,
      `${hostileDetail}; server alive after: ${alive}`
    );

    // 6. Referenced assets: every /-rooted badges.art_path in the DB the app
    //    serves must exist under src/public (#193's regression) …
    const publicDir = path.join(REPO_ROOT, 'src', 'public');
    const missingLive = missingBadgeArt(badgeRows, publicDir);
    check(
      'event-seed badge art all exists on disk',
      missingLive.length === 0,
      missingLive.map((b) => `${b.code} → ${b.art_path}`).join(', ')
    );

    // … and so must every art_path in scripts/seed.js's catalog, seeded into
    // its own scratch dir — the two catalogs are separate today (#193), so
    // auditing only the event seed would miss the wedding-day one.
    const seedJsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-smoke-seedjs-'));
    const seedJsRes = runSeeder('seed.js', [], seedJsDir);
    let missingSeedJs = [];
    if (seedJsRes.status === 0) {
      const seedDb = new Database(path.join(seedJsDir, 'app.db'), { readonly: true });
      missingSeedJs = missingBadgeArt(
        seedDb.prepare('SELECT code, art_path FROM badges').all(),
        publicDir
      );
      seedDb.close();
    }
    check(
      'seed.js badge art all exists on disk',
      seedJsRes.status === 0 && missingSeedJs.length === 0,
      seedJsRes.status !== 0
        ? `seed.js exited ${seedJsRes.status}`
        : missingSeedJs.map((b) => `${b.code} → ${b.art_path}`).join(', ')
    );
  } finally {
    // finish() below owns reporting; this finally only guarantees teardown
    // when a probe throws unexpectedly.
  }

  return finish(results, server);
}

function finish(results, server) {
  const { lines, exitCode } = summarize(results);
  for (const line of lines) console.log(line);
  if (server) server.close();
  // Explicit exit: better-sqlite3/keep-alive handles must not hold the gate open.
  process.exit(exitCode);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('smoke: harness error:', err);
    process.exit(1);
  });
}
