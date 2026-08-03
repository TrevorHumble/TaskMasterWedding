// tests/client-error-beacon.test.js
// Issue #1021 AC1-AC5: POST /client-error, the browser-side JS crash beacon
// (src/routes/guest/client-error.js). Supertest-driven, mirroring
// tests/csrf.test.js's guest/admin-agent-with-token helpers and
// tests/request-log.test.js's console.log-spy pattern for asserting the
// exact JSON line src/middleware/request-log.js's logClientError emits.
//
// REQUIRE ORDER: config / db / app / csrf are required only AFTER loadApp()
// sets DATA_DIR / DB_PATH (see tests/helpers/testApp.js).
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;
let csrf;
let clientErrorRouter;

beforeAll(() => {
  const loaded = loadApp();
  app = loaded.app;
  db = loaded.db;
  config = require('../config');
  csrf = require('../src/middleware/csrf');
  // The same router instance src/app.js mounted (Node's require cache),
  // needed for AC3's _size() bound.
  clientErrorRouter = require('../src/routes/guest/client-error');
});

/**
 * Every console.log call captured by a spy, parsed as JSON, filtered to this
 * route's own line shape -- same helper as tests/request-log.test.js, plus
 * the kind filter so a request-log finish/close line for the SAME POST
 * (request-log.js still logs its own line for a >=400 status, or under
 * LOG_ALL_REQUESTS) never gets mistaken for the client-error line.
 */
function clientErrorLines(logSpy) {
  return logSpy.mock.calls
    .map((args) => args[0])
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed !== null && parsed.kind === 'client-error');
}

function extractToken(html) {
  const m = /<meta name="csrf-token" content="([^"]*)">/.exec(html);
  expect(m).toBeTruthy();
  expect(m[1].length).toBeGreaterThan(0);
  return m[1];
}

let guestCounter = 0;
/** A signed-in guest agent that has already GETted a page, minting the real
 * csrf cookie + token (same flow tests/csrf.test.js's guestAgentWithToken
 * uses). */
async function guestAgentWithToken() {
  guestCounter += 1;
  const token = `ce1021-${guestCounter}-${Date.now()}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, `CE Guest ${guestCounter}`).lastInsertRowid;
  const agent = signInGuest(app, token);
  const homeRes = await agent.get('/');
  const csrfToken = extractToken(homeRes.text);
  return { agent, guestId, csrfToken };
}

/** An anonymous (never signed-in) agent, csrf token minted off GET /join --
 * the "crash on /join itself" case AC2 covers. */
async function anonymousAgentWithToken() {
  const agent = request.agent(app);
  const joinRes = await agent.get('/join');
  const csrfToken = extractToken(joinRes.text);
  return { agent, csrfToken };
}

describe('POST /client-error (#1021)', () => {
  it('AC1: a signed-in guest report logs one line with kind/message/stack/url/guestId/userAgent, truncated server-side even for an oversized direct POST', async () => {
    const { agent, guestId, csrfToken } = await guestAgentWithToken();
    // A distinct leading character, not a uniform repeat: proves the server
    // keeps the FRONT 500/2000 characters, not an arbitrary (or reversed)
    // slice that would still pass a same-character length-only assertion.
    const oversizedMessage = 'M' + 'm'.repeat(599); // 600 chars, > 500-char server cap
    const oversizedStack = 'S' + 's'.repeat(2499); // 2500 chars, > 2000-char server cap
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await agent
        .post('/client-error')
        .set('X-CSRF-Token', csrfToken)
        .set('User-Agent', 'ClientErrorTest/1.0')
        .send({ message: oversizedMessage, stack: oversizedStack, url: '/tasks/5' });
      expect(res.status).toBe(204);

      const lines = clientErrorLines(logSpy);
      expect(lines.length).toBe(1);
      const line = lines[0];
      expect(line.kind).toBe('client-error');
      // Real VALUE assertions, not just length: the exact first 500/2000
      // characters of the string sent, not a differently-truncated,
      // reversed, or garbled copy.
      expect(line.message).toBe('M' + 'm'.repeat(499));
      expect(line.stack).toBe('S' + 's'.repeat(1999));
      expect(line.url).toBe('/tasks/5');
      expect(line.guestId).toBe(guestId);
      expect(line.userAgent).toBe('ClientErrorTest/1.0');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('AC1 edge: a body missing message/stack/url entirely still logs one line with empty strings, not a thrown 500', async () => {
    const { agent, csrfToken } = await guestAgentWithToken();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await agent.post('/client-error').set('X-CSRF-Token', csrfToken).send({});
      expect(res.status).toBe(204);

      const lines = clientErrorLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].message).toBe('');
      expect(lines[0].stack).toBe('');
      expect(lines[0].url).toBe('');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('AC1 edge: a top-level JSON array body (valid strict-mode JSON, but not an object shape with message/stack/url) still logs one line with empty strings, not a thrown 500', async () => {
    const { agent, csrfToken } = await guestAgentWithToken();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await agent
        .post('/client-error')
        .set('X-CSRF-Token', csrfToken)
        .set('Content-Type', 'application/json')
        .send('[1,2,3]');
      expect(res.status).toBe(204);

      const lines = clientErrorLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].message).toBe('');
      expect(lines[0].stack).toBe('');
      expect(lines[0].url).toBe('');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('AC2: a signed-out visitor (crashing on /join itself) with a valid csrf token logs guestId null', async () => {
    const { agent, csrfToken } = await anonymousAgentWithToken();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await agent
        .post('/client-error')
        .set('X-CSRF-Token', csrfToken)
        .send({ message: 'crash before joining', stack: 'at Join.render', url: '/join' });
      expect(res.status).toBe(204);

      const lines = clientErrorLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].guestId).toBeNull();
      expect(lines[0].message).toBe('crash before joining');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('AC3: the same guest posting an identical message+stack twice within 30s logs only once', async () => {
    const { agent, csrfToken } = await guestAgentWithToken();
    const payload = { message: 'AC3 duplicate report', stack: 'at Duplicate.fn', url: '/tasks' };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res1 = await agent.post('/client-error').set('X-CSRF-Token', csrfToken).send(payload);
      const res2 = await agent.post('/client-error').set('X-CSRF-Token', csrfToken).send(payload);
      // Both requests succeed at the HTTP layer -- dedupe is a silent,
      // server-side decision, never surfaced to the client as an error.
      expect(res1.status).toBe(204);
      expect(res2.status).toBe(204);

      const lines = clientErrorLines(logSpy).filter((l) => l.message === 'AC3 duplicate report');
      expect(lines.length).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('AC3: an identical report logs again once the 30s dedupe window has elapsed', async () => {
    const { agent, csrfToken } = await guestAgentWithToken();
    const payload = { message: 'AC3 expiry report', stack: 'at Expiry.fn', url: '/tasks' };
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    let simulatedNow = Date.now();
    const restoreNow = clientErrorRouter._setNowForTest(() => simulatedNow);
    try {
      const res1 = await agent.post('/client-error').set('X-CSRF-Token', csrfToken).send(payload);
      expect(res1.status).toBe(204);

      // Still inside the window: deduped, same as the AC3 duplicate test.
      const res2 = await agent.post('/client-error').set('X-CSRF-Token', csrfToken).send(payload);
      expect(res2.status).toBe(204);

      // Advance past CLIENT_ERROR_DEDUPE_WINDOW_MS (30000ms) -- if the
      // window never expired (e.g. the freshness check were weakened to a
      // bare "key exists"), this third post would also be swallowed and the
      // assertion below would fail.
      simulatedNow += 30001;
      const res3 = await agent.post('/client-error').set('X-CSRF-Token', csrfToken).send(payload);
      expect(res3.status).toBe(204);

      const lines = clientErrorLines(logSpy).filter((l) => l.message === 'AC3 expiry report');
      expect(lines.length).toBe(2);
    } finally {
      logSpy.mockRestore();
      restoreNow();
    }
  });

  it('AC3: a DIFFERENT message from the same guest inside the same 30s window is not deduped', async () => {
    const { agent, csrfToken } = await guestAgentWithToken();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await agent
        .post('/client-error')
        .set('X-CSRF-Token', csrfToken)
        .send({ message: 'AC3 distinct A', stack: 'at A.fn', url: '/tasks' });
      await agent
        .post('/client-error')
        .set('X-CSRF-Token', csrfToken)
        .send({ message: 'AC3 distinct B', stack: 'at B.fn', url: '/tasks' });

      const lines = clientErrorLines(logSpy).filter((l) => l.message.indexOf('AC3 distinct') === 0);
      expect(lines.length).toBe(2);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("AC3 bound: the dedupe map's _size() never exceeds a lowered RATE_LIMIT_TRACKED_MAX under a distinct-report flood (CLIENT_ERROR_RATE_MAX raised so the cap is reachable)", async () => {
    const { agent, csrfToken } = await guestAgentWithToken();
    const originalTrackedMax = config.RATE_LIMIT_TRACKED_MAX;
    const originalRateMax = config.CLIENT_ERROR_RATE_MAX;
    // Raised well past the flood size below (issue text: "CLIENT_ERROR_RATE_MAX
    // raised for the test so the cap is reachable") -- otherwise the RATE
    // limiter itself (a separate mechanism, checked before the dedupe map is
    // ever touched) would 429 this flood long before the dedupe cap could be
    // exercised.
    config.RATE_LIMIT_TRACKED_MAX = 5;
    config.CLIENT_ERROR_RATE_MAX = 50;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (let i = 0; i < 20; i++) {
        await agent
          .post('/client-error')
          .set('X-CSRF-Token', csrfToken)
          .send({ message: 'AC3 flood ' + i, stack: 'at Flood.fn' + i, url: '/tasks' });
      }
      expect(clientErrorRouter._size()).toBeLessThanOrEqual(config.RATE_LIMIT_TRACKED_MAX);
    } finally {
      logSpy.mockRestore();
      config.RATE_LIMIT_TRACKED_MAX = originalTrackedMax;
      config.CLIENT_ERROR_RATE_MAX = originalRateMax;
    }
  });

  it('AC4: a POST with a missing/invalid CSRF token (legacy bypass disabled) is refused the standard CSRF rejection and logs nothing', async () => {
    const { agent } = await guestAgentWithToken();
    csrf._setLegacyBypassForTest(false);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const noTokenRes = await agent
        .post('/client-error')
        .send({ message: 'AC4 no token', stack: 'x', url: '/tasks' });
      expect(noTokenRes.status).toBe(403);

      const wrongTokenRes = await agent
        .post('/client-error')
        .set('X-CSRF-Token', 'definitely-not-the-real-token')
        .send({ message: 'AC4 wrong token', stack: 'x', url: '/tasks' });
      expect(wrongTokenRes.status).toBe(403);

      const lines = clientErrorLines(logSpy);
      expect(lines.length).toBe(0);
    } finally {
      logSpy.mockRestore();
      // Restored so every OTHER test file's own module instance is
      // unaffected (vitest's per-file isolation already scopes this, but
      // restoring is also right for any later test in THIS file).
      csrf._setLegacyBypassForTest(true);
    }
  });

  it('AC5: over CLIENT_ERROR_RATE_MAX responds 429, and a subsequent POST /bug-report from the same guest still succeeds (independent budgets)', async () => {
    const { agent, csrfToken } = await guestAgentWithToken();
    const originalMax = config.CLIENT_ERROR_RATE_MAX;
    config.CLIENT_ERROR_RATE_MAX = 1;
    try {
      const res1 = await agent
        .post('/client-error')
        .set('X-CSRF-Token', csrfToken)
        .send({ message: 'AC5 first', stack: 'x', url: '/tasks' });
      expect(res1.status).toBe(204);

      const res2 = await agent
        .post('/client-error')
        .set('X-CSRF-Token', csrfToken)
        .send({ message: 'AC5 second, over budget', stack: 'x', url: '/tasks' });
      expect(res2.status).toBe(429);

      const bugRes = await agent
        .post('/bug-report')
        .set('X-CSRF-Token', csrfToken)
        .send({ body: 'AC5: still works after client-error is over budget' });
      expect([301, 302, 303]).toContain(bugRes.status);

      const row = db
        .prepare(`SELECT body FROM bug_reports WHERE body = ?`)
        .get('AC5: still works after client-error is over budget');
      expect(row).toBeTruthy();
    } finally {
      config.CLIENT_ERROR_RATE_MAX = originalMax;
    }
  });
});
