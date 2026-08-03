// tests/request-log.test.js
// Issue #1019 AC1-AC5: structured per-request JSON logging to stdout
// (src/middleware/request-log.js), wired as the FIRST app.use in
// src/app.js, plus the correlated supplementary error line the global
// error handler adds.
//
// ONE loadApp() for the whole file (same convention as tests/rate-limit.test.js
// and every other supertest-driven file in this repo -- `require('../../src/app')`
// is cached after its first call within one test file, so all describe blocks
// below share one app/db/config instance). Each test that needs a non-default
// config.LOG_ALL_REQUESTS/LOG_SLOW_MS/RATE_LIMIT_IP_MAX mutates the already-
// loaded config object directly and restores it in a finally block, same
// pattern rate-limit.test.js uses.
'use strict';

const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

let app;
let db;
let config;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  db = result.db;
  config = require('../config');
});

/**
 * Every console.log call captured by a spy, parsed as JSON. Calls that are
 * not valid JSON (there should be none from this app's own request path, but
 * a stray unrelated console.log elsewhere must not crash the test) are
 * dropped rather than thrown on.
 */
function parsedLogLines(logSpy) {
  return logSpy.mock.calls
    .map((args) => args[0])
    .map((raw) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    })
    .filter((parsed) => parsed !== null);
}

let guestCounter = 0;
/** Insert a fresh guest row with a unique token and sign an agent in as them. */
function makeSignedInGuest() {
  guestCounter += 1;
  const token = `rl1019-${guestCounter}`;
  const guestId = db
    .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
    .run(token, `RL1019 Guest ${guestCounter}`).lastInsertRowid;
  return { guestId, agent: signInGuest(app, token) };
}

describe('request-log middleware (#1019)', () => {
  it('AC1: LOG_ALL_REQUESTS=1 logs exactly one parseable line for a signed-in guest GET /tasks 200, with reqId/guestId/method/path/status/durationMs', async () => {
    const originalLogAll = config.LOG_ALL_REQUESTS;
    config.LOG_ALL_REQUESTS = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { guestId, agent } = makeSignedInGuest();

      const res = await agent.get('/tasks');
      expect(res.status).toBe(200);

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(1);

      const line = lines[0];
      expect(line.reqId).toMatch(/^[0-9a-f]{8}$/);
      expect(line.guestId).toBe(guestId);
      expect(line.method).toBe('GET');
      expect(line.path).toBe('/tasks');
      expect(line.status).toBe(200);
      expect(typeof line.durationMs).toBe('number');
    } finally {
      logSpy.mockRestore();
      config.LOG_ALL_REQUESTS = originalLogAll;
    }
  });

  it('AC2: a route that throws produces two stdout lines sharing one req.reqId -- the finish line (status 500) and a supplementary error line (message + stack)', async () => {
    const originalPrepare = db.prepare.bind(db);
    // GET /tasks' own task-listing query is the one that carries this
    // distinctive JOIN -- forcing it to throw exercises the real global
    // error handler in src/app.js, not a hand-built fake.
    const dbSpy = vi.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes('LEFT JOIN submissions')) {
        throw new Error('boom: forced AC2 request-log failure');
      }
      return originalPrepare(sql);
    });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { agent } = makeSignedInGuest();

      const res = await agent.get('/tasks');
      expect(res.status).toBe(500);

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(2);

      const finishLine = lines.find((l) => l.status !== undefined);
      const errorLine = lines.find((l) => l.err !== undefined);
      expect(finishLine).toBeTruthy();
      expect(errorLine).toBeTruthy();

      expect(finishLine.status).toBe(500);
      expect(typeof finishLine.reqId).toBe('string');
      expect(errorLine.reqId).toBe(finishLine.reqId);
      expect(errorLine.err).toContain('boom: forced AC2 request-log failure');
      expect(typeof errorLine.stack).toBe('string');
      expect(errorLine.stack).toContain('boom: forced AC2 request-log failure');
    } finally {
      dbSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it('AC3: with LOG_ALL_REQUESTS unset, a 404, a 413 (real oversized body), and a 429 each log a line carrying a reqId; a fast 200 logs nothing', async () => {
    expect(config.LOG_ALL_REQUESTS).toBe(false);

    // --- 404 on a non-static app path -----------------------------------
    // Signed-in agent: guest.js mounts a whole-router requireGuest gate on
    // every path under '/' (src/routes/guest.js), so an UNAUTHENTICATED
    // request to an unmatched path is redirected (302) to /join before it
    // ever reaches the app's own 404 handler. A signed-in guest clears that
    // gate and actually reaches the 404 case this test wants.
    {
      const { agent } = makeSignedInGuest();
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const res = await agent.get('/no-such-route-1019');
        expect(res.status).toBe(404);
        const lines = parsedLogLines(logSpy);
        expect(lines.length).toBe(1);
        expect(lines[0].status).toBe(404);
        expect(lines[0].reqId).toMatch(/^[0-9a-f]{8}$/);
      } finally {
        logSpy.mockRestore();
      }
    }

    // --- 413: a real oversized-body POST, same 17 KiB fixture shape as ---
    // --- tests/admin-login-body-cap.test.js's own 413 case ---------------
    {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const OVERSIZED = 'a'.repeat(17 * 1024);
        const res = await request(app)
          .post('/admin/login')
          .type('form')
          .send('password=' + OVERSIZED);
        expect(res.status).toBe(413);
        const lines = parsedLogLines(logSpy);
        expect(lines.length).toBe(1);
        expect(lines[0].status).toBe(413);
        // AC3's load-bearing claim: the 413 case still carries a reqId --
        // proof request-log is mounted AHEAD of the body parsers, since a
        // later mount would never see this request at all (Express routes
        // an over-limit body straight to the 413 passthrough handler,
        // skipping any middleware registered after the parser).
        expect(lines[0].reqId).toMatch(/^[0-9a-f]{8}$/);
      } finally {
        logSpy.mockRestore();
      }
    }

    // --- 429 from the existing IP-keyed POST /login rate limiter ---------
    {
      const originalMax = config.RATE_LIMIT_IP_MAX;
      config.RATE_LIMIT_IP_MAX = 0;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const res = await request(app)
          .post('/login')
          .type('form')
          .send({ contact: 'rl1019-nobody@example.com', pin: '0000' });
        expect(res.status).toBe(429);
        const lines = parsedLogLines(logSpy);
        expect(lines.length).toBe(1);
        expect(lines[0].status).toBe(429);
        expect(lines[0].reqId).toMatch(/^[0-9a-f]{8}$/);
      } finally {
        logSpy.mockRestore();
        config.RATE_LIMIT_IP_MAX = originalMax;
      }
    }

    // --- a fast, successful 200 logs nothing by default -------------------
    {
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const res = await request(app).get('/join');
        // GET /join is a real, fast, unauthenticated app route.
        expect(res.status).toBe(200);
        const lines = parsedLogLines(logSpy);
        expect(lines.length).toBe(0);
      } finally {
        logSpy.mockRestore();
      }
    }
  });

  it('AC4: LOG_SLOW_MS=1 with a handler forced past 1ms by a spied service logs one line with durationMs >= 1 -- deterministic, not timing luck', async () => {
    const originalSlowMs = config.LOG_SLOW_MS;
    config.LOG_SLOW_MS = 1;
    // Force GET /tasks' own eventDays.eventLocalDateString call to cost at
    // least a couple of milliseconds of REAL wall-clock time before
    // delegating to the real implementation -- deterministic in the sense
    // that the delay is imposed by the spy itself, not left to whatever the
    // route would naturally take (which could legitimately land under 1ms on
    // a fast machine and make the test flaky).
    const eventDays = require('../src/services/event-days');
    const realEventLocalDateString = eventDays.eventLocalDateString.bind(eventDays);
    const eventDaysSpy = vi
      .spyOn(eventDays, 'eventLocalDateString')
      .mockImplementation((...args) => {
        const start = Date.now();
        while (Date.now() - start < 3) {
          // busy-wait: guarantees >= 3ms of real elapsed time inside this
          // request, comfortably clearing LOG_SLOW_MS=1 regardless of how
          // fast the rest of the handler runs.
        }
        return realEventLocalDateString(...args);
      });
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { agent } = makeSignedInGuest();

      const res = await agent.get('/tasks');
      expect(res.status).toBe(200);

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].durationMs).toBeGreaterThanOrEqual(1);
    } finally {
      eventDaysSpy.mockRestore();
      logSpy.mockRestore();
      config.LOG_SLOW_MS = originalSlowMs;
    }
  });

  it('AC5: static and probe paths never log, served or missed, even with LOG_ALL_REQUESTS=1', async () => {
    const originalLogAll = config.LOG_ALL_REQUESTS;
    config.LOG_ALL_REQUESTS = true;
    // Signed-in agent for the same reason AC3's 404 case uses one: guest.js's
    // whole-router requireGuest gate (src/routes/guest.js) would otherwise
    // redirect (302) an unauthenticated request to any of these paths that
    // misses its static mount, before AC5's "missed (404)" case is ever
    // actually exercised.
    const { agent } = makeSignedInGuest();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const paths = [
        ['/uploads/does-not-exist.jpg', 404], // under the skip prefix
        ['/thumbs/does-not-exist.jpg', 404], // under the skip prefix
        ['/css/does-not-exist.css', 404], // under the skip prefix
        ['/js/does-not-exist.js', 404], // under the skip prefix
        ['/badges/does-not-exist.svg', 404], // under the skip prefix
        ['/fonts/does-not-exist.woff2', 404], // under the skip prefix
        ['/robots.txt', 200], // a real bundled static file
        ['/favicon.ico', 404], // no file, browsers request it unprompted
        ['/healthz', 200], // liveness probe
      ];

      for (const [p, expectedStatus] of paths) {
        const res = await agent.get(p);
        // Each path's own actual expected status, so a change to a fixture
        // (e.g. robots.txt removed, or renamed) fails loudly here instead of
        // silently passing AC5 for the wrong reason.
        expect(res.status).toBe(expectedStatus);
      }

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(0);
    } finally {
      logSpy.mockRestore();
      config.LOG_ALL_REQUESTS = originalLogAll;
    }
  });

  it('the `path` field carries the query-stripped path, not req.originalUrl', async () => {
    const originalLogAll = config.LOG_ALL_REQUESTS;
    config.LOG_ALL_REQUESTS = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { agent } = makeSignedInGuest();

      const res = await agent.get('/tasks?foo=bar&baz=1');
      expect(res.status).toBe(200);

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].path).toBe('/tasks');
    } finally {
      logSpy.mockRestore();
      config.LOG_ALL_REQUESTS = originalLogAll;
    }
  });

  it('a newly added top-level entry under config.PUBLIC_DIR is skipped without editing the middleware', () => {
    const fsMod = require('fs');
    const osMod = require('os');
    const pathMod = require('path');
    const EventEmitter = require('events');
    const originalPublicDir = config.PUBLIC_DIR;
    const originalLogAll = config.LOG_ALL_REQUESTS;
    const tempDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'gpp-public-'));
    fsMod.mkdirSync(pathMod.join(tempDir, 'newkind'));
    const resolvedPath = require.resolve('../src/middleware/request-log');
    try {
      config.PUBLIC_DIR = tempDir;
      // Force every request through the shouldLog branch, so a path under
      // the new prefix logging nothing is proof of the skip list, not
      // coincidence (a fast 200 would stay silent either way).
      config.LOG_ALL_REQUESTS = true;
      delete require.cache[resolvedPath];
      const fresh = require('../src/middleware/request-log');
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        // 'newkind' exists only in tempDir, added after the module computed
        // its prefixes at require time -- this proves the skip list is
        // derived from a live directory read, not a hand-maintained literal
        // list that would need its own edit, by observing that a request
        // under it produces no log line.
        const skippedReq = { method: 'GET', originalUrl: '/newkind/foo.png', guest: null };
        const skippedRes = new EventEmitter();
        skippedRes.statusCode = 200;
        fresh.requestLog(skippedReq, skippedRes, () => {});
        skippedRes.writableFinished = true;
        skippedRes.emit('finish');

        // A path that merely resembles a prefix (not actually one) still
        // logs, proving the skip check is not accidentally skipping everything.
        const otherReq = { method: 'GET', originalUrl: '/not-a-real-prefix/foo.png', guest: null };
        const otherRes = new EventEmitter();
        otherRes.statusCode = 200;
        fresh.requestLog(otherReq, otherRes, () => {});
        otherRes.writableFinished = true;
        otherRes.emit('finish');

        const lines = parsedLogLines(logSpy);
        expect(lines.length).toBe(1);
        expect(lines[0].path).toBe('/not-a-real-prefix/foo.png');
      } finally {
        logSpy.mockRestore();
      }
    } finally {
      config.PUBLIC_DIR = originalPublicDir;
      config.LOG_ALL_REQUESTS = originalLogAll;
      delete require.cache[resolvedPath];
      // Restore the module cache to reflect the real PUBLIC_DIR before any
      // later test in this file (or another file sharing this process)
      // re-requires it.
      require('../src/middleware/request-log');
      fsMod.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('a client-aborted response (close fires, finish never does) logs once, marked aborted with status null', () => {
    const EventEmitter = require('events');
    const { requestLog } = require('../src/middleware/request-log');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const req = { method: 'POST', originalUrl: '/tasks/1/submit', guest: { id: 42 } };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableFinished = false;
      const next = vi.fn();

      requestLog(req, res, next);
      expect(next).toHaveBeenCalledTimes(1);
      res.emit('close'); // client aborted mid-request -- 'finish' never fires

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].status).toBeNull();
      expect(lines[0].aborted).toBe(true);
      expect(lines[0].path).toBe('/tasks/1/submit');
      expect(lines[0].reqId).toMatch(/^[0-9a-f]{8}$/);
      expect(lines[0].guestId).toBe(42);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a response destroyed after res.end() but before "finish" is confirmed still logs one aborted line (writableEnded true, writableFinished false)', () => {
    // Regression case: res.writableEnded flips to true synchronously inside
    // res.end(), before the underlying stream actually finishes flushing --
    // 'finish' is what confirms that. A socket destroyed in that window
    // emits 'close' with writableEnded already true but writableFinished
    // still false, and 'finish' never fires. Guarding on writableEnded would
    // make both handlers decline and the request would log nothing at all --
    // the exact failed-delivery case the abort branch exists to catch. This
    // asserts the guard reads writableFinished instead.
    const EventEmitter = require('events');
    const { requestLog } = require('../src/middleware/request-log');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const req = { method: 'POST', originalUrl: '/tasks/1/submit', guest: { id: 9 } };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableEnded = true; // res.end() was called...
      res.writableFinished = false; // ...but 'finish' never actually fired
      const next = vi.fn();

      requestLog(req, res, next);
      res.emit('close'); // socket destroyed before flush confirmation

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].status).toBeNull();
      expect(lines[0].aborted).toBe(true);
    } finally {
      logSpy.mockRestore();
    }
  });

  it('a normally completed response (finish then close) never double-logs via the abort branch', () => {
    const EventEmitter = require('events');
    const { requestLog } = require('../src/middleware/request-log');
    const originalLogAll = config.LOG_ALL_REQUESTS;
    config.LOG_ALL_REQUESTS = true;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const req = { method: 'GET', originalUrl: '/tasks', guest: { id: 7 } };
      const res = new EventEmitter();
      res.statusCode = 200;
      res.writableFinished = false;
      const next = vi.fn();

      requestLog(req, res, next);
      // Real Node sets writableFinished true immediately before 'finish' is
      // emitted; the mock replicates that ordering.
      res.writableFinished = true;
      res.emit('finish');
      res.emit('close'); // fires right after 'finish' on a real completed response

      const lines = parsedLogLines(logSpy);
      expect(lines.length).toBe(1);
      expect(lines[0].status).toBe(200);
      expect(lines[0].aborted).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      config.LOG_ALL_REQUESTS = originalLogAll;
    }
  });
});
