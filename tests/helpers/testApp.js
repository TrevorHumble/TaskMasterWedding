// tests/helpers/testApp.js
// Helpers for spinning up an isolated app instance during tests.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const request = require('supertest');

/**
 * Load the app pointed at a fresh temp database.
 *
 * REQUIRE ORDER MATTERS: config.js and db.js both read DATA_DIR / DB_PATH at
 * first require time (module-level code runs immediately). The environment
 * variables MUST be set before any of those three modules are required —
 * including transitively (app.js requires config; db.js requires config).
 * Because Node caches modules, the only safe way to guarantee env is set first
 * is to set it here, before any require call that pulls in config or db.
 *
 * @returns {{ app: import('express').Application, db: import('better-sqlite3').Database }}
 */
function loadApp() {
  // 1. Create a unique temp dir for this test run.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-test-'));

  // 2. Point the app at the temp dir BEFORE requiring config, db, or app.
  //    config.js reads these at module-level, so env must be set first.
  process.env.DATA_DIR = dir;
  process.env.DB_PATH = path.join(dir, 'test.db');

  // 3. Now it is safe to require the modules (they will read the env vars above).
  const app = require('../../src/app');
  const { db } = require('../../src/db');

  return { app, db };
}

/**
 * Seed the database with the minimum data needed to assert behavioral tests:
 * one task, one guest, and one non-taken-down submission joining them.
 *
 * @param {import('better-sqlite3').Database} db
 * @returns {{ taskId: number, guestId: number, submissionId: number }}
 */
function seed(db) {
  const taskId = db
    .prepare(`INSERT INTO tasks (title) VALUES (?)`)
    .run('Selfie with the cake').lastInsertRowid;

  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run('seedtoken', 'Seed Guest').lastInsertRowid;

  const submissionId = db
    .prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    )
    .run(guestId, taskId, 'p.jpg', 't.jpg').lastInsertRowid;

  return { taskId, guestId, submissionId };
}

/**
 * Write a known bcrypt hash to the admin.hash path used by the temp DATA_DIR,
 * then return a supertest agent that is already logged in as admin.
 *
 * REQUIRE ORDER: call this AFTER loadApp() so config has already been required
 * with the correct DATA_DIR env var.
 *
 * @param {import('express').Application} app
 * @param {string} password - plain-text password to use (arbitrary for tests)
 * @returns {Promise<import('supertest').SuperAgentTest>}
 */
async function makeAdminAgent(app, password = 'test-admin-pw') {
  // config is already cached with the temp DATA_DIR set by loadApp().
  const config = require('../../config');
  // bcryptjs cost 10 matches set-admin-password.js.
  const hash = bcrypt.hashSync(password, 10);
  fs.mkdirSync(path.dirname(config.ADMIN_HASH_PATH), { recursive: true });
  fs.writeFileSync(config.ADMIN_HASH_PATH, hash, 'utf8');

  const agent = request.agent(app);
  await agent.post('/admin/login').type('form').send({ password });
  return agent;
}

/**
 * Sign a raw cookie value the exact way `cookie-parser` (via the
 * `cookie-signature` package) verifies it: `value + '.' + base64(HMAC-SHA256(
 * value, secret))`, trailing `=` padding stripped. This is cookie-parser's
 * private wire format for a *signed cookie's* content — the `s:` prefix
 * cookie-parser strips before unsigning is added by the caller below, not
 * here (mirrors how `res.cookie(name, value, { signed: true })` builds it in
 * production: `'s:' + signature.sign(value, secret)`).
 *
 * `cookie-signature` is a transitive dependency (pulled in by cookie-parser),
 * not a top-level one, so this reproduces its two-line algorithm with node's
 * own `crypto` instead of reaching into another package's node_modules.
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
 * Sign in a supertest agent as the guest holding `token`, without making any
 * HTTP request — issue #244 retired GET /j/:token (the route every test used
 * to hit to establish a guest session), so a test can no longer sign in by
 * visiting a URL. Instead this mints the exact signed `gsid` cookie
 * attachGuest (src/middleware/session.js) expects and seeds it directly into
 * the agent's cookie jar, which supertest/superagent then attaches to every
 * subsequent request from that agent — same end state as the old
 * `agent.get('/j/' + token)`, one function call instead of a network round trip.
 *
 * MUST be called after loadApp() (config needs the temp DATA_DIR already set —
 * see loadApp's REQUIRE ORDER note above) and after the guest row with this
 * token already exists in the DB (this function performs no DB write itself).
 *
 * @param {import('express').Application} app
 * @param {string} token - a guest's `guests.token` value already in the DB.
 * @param {import('supertest').SuperAgentTest} [agent] - reuse an existing
 *   agent instead of creating a new one (e.g. one already holding other
 *   cookies a test needs to keep).
 * @returns {import('supertest').SuperAgentTest}
 */
function signInGuest(app, token, agent) {
  // config is already cached with the temp DATA_DIR set by loadApp().
  const config = require('../../config');
  const signed = signCookieValue(token, config.COOKIE_SECRET);
  // The cookie's value on the wire is percent-encoded (Express/`cookie`
  // encodes with encodeURIComponent by default) — reproduce that here so the
  // stored jar entry decodes back to the same signed value cookie-parser
  // would unsign from a real Set-Cookie response.
  const wireValue = encodeURIComponent(`s:${signed}`);
  const theAgent = agent || request.agent(app);
  // superagent's Agent keeps a `cookiejar`-package CookieJar (not a WHATWG
  // one); setCookie(cookieString) parses one Set-Cookie-style string and
  // stores it for every future request from this agent, exactly like a real
  // response's Set-Cookie would have.
  theAgent.jar.setCookie(`gsid=${wireValue}; Path=/`);
  return theAgent;
}

module.exports = { loadApp, seed, makeAdminAgent, signInGuest };
