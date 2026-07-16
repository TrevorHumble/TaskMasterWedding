// tests/session-stickiness.test.js
// Issue #242 — rolling 400-day guest sessions, admin cookie left at 14 days,
// and a hard production boot failure when COOKIE_SECRET is unset.
//
// Sign-in mechanism migrated off the retired GET /j/:token (issue #244 — that
// route now just 302s to /join and sets no cookie) to a real POST /join
// signup, which is the route that actually sets `gsid` via
// cookieOpts(config.GUEST_COOKIE_MAX_AGE_MS). #242's intent (the rolling
// 400-day Max-Age) is unaffected by #244 — it still lives in
// src/middleware/session.js's attachGuest — so these assertions are unchanged
// in substance, just observed on the current sign-in path.
//
// AC1: a successful guest sign-in (POST /join)'s Set-Cookie for `gsid`
//      carries Max-Age=34560000 (400 days in seconds).
// AC2: a request carrying a valid `gsid` cookie gets a FRESH Set-Cookie for
//      `gsid` (still Max-Age=34560000) on every subsequent authenticated
//      request — the rolling refresh.
// AC3: a successful admin login's Set-Cookie for `admin` carries
//      Max-Age=1209600 (the unchanged 14 days); no guest-page response ever
//      carries a Set-Cookie for `admin`.
// AC4: NODE_ENV=production + no COOKIE_SECRET -> `node -e "require('./config')"`
//      exits nonzero, stderr contains "COOKIE_SECRET".
// AC5: NODE_ENV not production + no COOKIE_SECRET -> config loads, process
//      does not exit, and the existing warning containing
//      "COOKIE_SECRET is not set" is printed.
//
// REQUIRE ORDER: loadApp() must run before any require of config/db (see
// tests/helpers/testApp.js "REQUIRE ORDER MATTERS").
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

const REPO_ROOT = path.join(__dirname, '..');

describe('rolling guest cookie / unchanged admin cookie (issue #242, AC1-AC3)', () => {
  let app;

  beforeAll(() => {
    const loaded = loadApp();
    app = loaded.app;

    const fs = require('fs');
    const bcrypt = require('bcryptjs');
    const config = require('../config');
    fs.mkdirSync(path.dirname(config.ADMIN_HASH_PATH), { recursive: true });
    fs.writeFileSync(config.ADMIN_HASH_PATH, bcrypt.hashSync('StickySessions!9', 10), 'utf8');
  });

  it('AC1: POST /join sign-in sets gsid with Max-Age=34560000', async () => {
    const res = await request(app)
      .post('/join')
      .field('name', 'Sticky Guest')
      .field('contact', 'sticky-ac1@example.com')
      .field('pin', '4321');
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const gsid = cookies.find((c) => c.startsWith('gsid='));
    expect(gsid).toBeTruthy();
    // Real observable VALUE — 400 days in seconds, not just "a Max-Age exists".
    // Inverting to the pre-#242 14-day literal would fail this assertion.
    expect(gsid).toMatch(/Max-Age=34560000\b/);
  });

  it('AC2: every subsequent authenticated request re-issues gsid with a fresh Max-Age=34560000', async () => {
    const agent = request.agent(app);
    // Sign in once, via the real self-serve signup route (POST /join) — the
    // agent persists the resulting gsid cookie for the follow-up request.
    const signIn = await agent
      .post('/join')
      .field('name', 'Sticky Guest Two')
      .field('contact', 'sticky-ac2@example.com')
      .field('pin', '5678');
    const signInCookies = [].concat(signIn.headers['set-cookie'] || []);
    expect(signInCookies.find((c) => c.startsWith('gsid='))).toBeTruthy();

    // A second, unrelated guest-page request on the same session must ALSO
    // carry a fresh Set-Cookie for gsid — this is the rolling-refresh
    // behavior, not just the one-time sign-in cookie. A middleware that only
    // set the cookie at sign-in (the pre-#242 behavior) would leave this
    // response with no Set-Cookie for gsid at all.
    const second = await agent.get('/how-to-play');
    const secondCookies = [].concat(second.headers['set-cookie'] || []);
    const gsid = secondCookies.find((c) => c.startsWith('gsid='));
    expect(gsid).toBeTruthy();
    expect(gsid).toMatch(/Max-Age=34560000\b/);
  });

  it('AC2 (edge): a request with NO gsid cookie carries no Set-Cookie for gsid', async () => {
    // No agent/cookie jar — a fresh, signed-out request. attachGuest must not
    // manufacture a guest cookie for a visitor who never signed in.
    const res = await request(app).get('/how-to-play');
    const cookies = [].concat(res.headers['set-cookie'] || []);
    expect(cookies.find((c) => c.startsWith('gsid='))).toBeUndefined();
  });

  it('AC3: POST /admin/login sets admin with Max-Age=1209600 (unchanged 14 days)', async () => {
    const res = await request(app)
      .post('/admin/login')
      .type('form')
      .send({ password: 'StickySessions!9' });
    expect(res.status).toBe(302);
    const cookies = [].concat(res.headers['set-cookie'] || []);
    const adminCookie = cookies.find((c) => c.startsWith('admin='));
    expect(adminCookie).toBeTruthy();
    // Real observable VALUE — the pre-existing 14-day figure. If #242 had
    // accidentally widened the admin cookie to the new 400-day guest value,
    // this would fail.
    expect(adminCookie).toMatch(/Max-Age=1209600\b/);
  });

  it('AC3: a signed-in admin loading a guest page never gets a Set-Cookie for admin', async () => {
    const agent = request.agent(app);
    await agent.post('/admin/login').type('form').send({ password: 'StickySessions!9' });

    // attachGuest runs on every request, including ones from an admin-only
    // agent with no gsid cookie. It must never write (or rewrite) the admin
    // cookie — that would mean the guest-refresh logic reached across into
    // admin's cookie, the one thing AC3 forbids.
    const res = await agent.get('/how-to-play');
    const cookies = [].concat(res.headers['set-cookie'] || []);
    expect(cookies.find((c) => c.startsWith('admin='))).toBeUndefined();
  });
});

describe('COOKIE_SECRET boot behavior (issue #242, AC4-AC5)', () => {
  function spawnConfigLoad(env) {
    // process.env cloned and pruned rather than passed as-is: COOKIE_SECRET
    // must be ABSENT for both cases below, and this worktree has no .env file
    // (gitignored) so loadDotEnv cannot reintroduce it.
    const cleanEnv = { ...process.env };
    delete cleanEnv.COOKIE_SECRET;
    delete cleanEnv.DATA_DIR;
    delete cleanEnv.DB_PATH;
    Object.assign(cleanEnv, env);
    return spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: REPO_ROOT,
      env: cleanEnv,
      encoding: 'utf8',
    });
  }

  it('AC4: NODE_ENV=production + no COOKIE_SECRET exits nonzero and stderr names COOKIE_SECRET', () => {
    const result = spawnConfigLoad({ NODE_ENV: 'production' });
    // Real observable VALUES: a nonzero status AND the specific name in
    // stderr — not just "the process produced some output." A config.js that
    // silently fell back to the random-secret warning (the pre-#242
    // behavior) would exit 0 here and fail this assertion.
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/COOKIE_SECRET/);
  });

  it('AC5: NODE_ENV=test + no COOKIE_SECRET does not exit and still warns', () => {
    const result = spawnConfigLoad({ NODE_ENV: 'test' });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/COOKIE_SECRET is not set/);
  });

  it('AC5 (edge): NODE_ENV unset + no COOKIE_SECRET does not exit and still warns', () => {
    const cleanEnv = { ...process.env };
    delete cleanEnv.COOKIE_SECRET;
    delete cleanEnv.DATA_DIR;
    delete cleanEnv.DB_PATH;
    delete cleanEnv.NODE_ENV;
    const result = spawnSync(process.execPath, ['-e', "require('./config')"], {
      cwd: REPO_ROOT,
      env: cleanEnv,
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toMatch(/COOKIE_SECRET is not set/);
  });
});
