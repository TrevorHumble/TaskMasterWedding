// tests/hosting-lifecycle.test.js
// Issue #282 — trust proxy, /healthz, and graceful shutdown, for the move
// from laptop+tunnel to a rented host (DESIGN.md § Hosted deployment).
// AC1-AC3 exercise the real exported app via loadApp(); AC4 exercises only
// src/utils/shutdown.js against throwaway objects (never the shared app's
// live DB handle, which AC1/AC2 in this same file still need open);
// AC5-AC6 are source-string checks on the non-executed require.main guard.
'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');
const request = require('supertest');

const { loadApp } = require('./helpers/testApp');
const { installShutdownHandlers } = require('../src/utils/shutdown');

let app;
let config;

beforeAll(() => {
  const result = loadApp();
  app = result.app;
  // config is now cached with the temp DATA_DIR from loadApp().
  config = require('../config');
});

describe('/healthz answers without any cookie (AC1)', () => {
  it('GET /healthz -> 200, {"ok":true}, Content-Type application/json', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    // toMatchObject, not toEqual: issue #562 adds an additive `commit` field
    // (tests/healthz-commit.test.js owns asserting its actual value) that
    // toEqual's exact deep-equality would otherwise reject.
    expect(res.body).toMatchObject({ ok: true });
    expect(typeof res.body.commit).toBe('string');
    expect(res.headers['content-type']).toContain('application/json');
  });
});

describe('/healthz stays up during maintenance mode (AC2)', () => {
  it('config.MAINTENANCE = true -> GET /healthz is still 200 (not the 503 maintenance page)', async () => {
    config.MAINTENANCE = true;
    try {
      const res = await request(app).get('/healthz');
      expect(res.status).toBe(200);
      // toMatchObject, not toEqual — see the AC1 note above (issue #562).
      expect(res.body).toMatchObject({ ok: true });
      expect(typeof res.body.commit).toBe('string');
    } finally {
      config.MAINTENANCE = false;
    }
  });
});

// This project is CommonJS throughout (require(), not import()). vi.resetModules()
// resets vitest/vite-node's ESM module graph, but leaves Node's own native
// require.cache untouched for plain require() calls -- verified empirically:
// a second require('../config') after vi.resetModules() alone still returned
// the SAME cached module object (a change made here after the failing first
// attempt at this test). So config.js and src/app.js must be evicted from
// require.cache directly to force a real re-execution that re-reads
// process.env.TRUST_PROXY. src/db.js is deliberately left cached: it does not
// read TRUST_PROXY, and leaving it cached keeps the same DB handle loadApp()
// already opened rather than opening a second connection to the same file.
function reloadAppWithFreshConfig() {
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../src/app')];
  return require('../src/app');
}

describe('TRUST_PROXY env controls the Express setting (AC3)', () => {
  it("TRUST_PROXY='1' -> app.get('trust proxy') === 1; unset -> falsy", () => {
    const savedTrustProxy = process.env.TRUST_PROXY;
    try {
      process.env.TRUST_PROXY = '1';
      const appWithProxy = reloadAppWithFreshConfig();
      expect(appWithProxy.get('trust proxy')).toBe(1);

      delete process.env.TRUST_PROXY;
      const appWithoutProxy = reloadAppWithFreshConfig();
      expect(appWithoutProxy.get('trust proxy')).toBeFalsy();
    } finally {
      if (savedTrustProxy === undefined) {
        delete process.env.TRUST_PROXY;
      } else {
        process.env.TRUST_PROXY = savedTrustProxy;
      }
      // Reload once more so the module registry reflects the restored env,
      // leaving no stale TRUST_PROXY=1 config cached for a later test file.
      reloadAppWithFreshConfig();
    }
  });
});

describe('graceful shutdown closes the server and the DB (AC4)', () => {
  it('shutdown() stops the server, closes the DB, and calls exit(0)', async () => {
    // Throwaway objects only -- never the shared app's DB handle, which the
    // AC1/AC2 tests above still need open for the rest of this file.
    const throwawayApp = express();
    const throwawayServer = throwawayApp.listen(0);
    await new Promise((resolve) => throwawayServer.once('listening', resolve));
    const throwawayDb = new Database(':memory:');

    const exitCalls = [];
    let resolveExited;
    const exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    const fakeExit = (code) => {
      exitCalls.push(code);
      resolveExited();
    };

    const shutdown = installShutdownHandlers(throwawayServer, {
      db: throwawayDb,
      exit: fakeExit,
    });

    shutdown('SIGTERM');
    await exited;

    expect(throwawayServer.listening).toBe(false);
    expect(throwawayDb.open).toBe(false);
    expect(exitCalls).toEqual([0]);
  });

  it('a second shutdown() call is a no-op (idempotent)', async () => {
    const throwawayApp = express();
    const throwawayServer = throwawayApp.listen(0);
    await new Promise((resolve) => throwawayServer.once('listening', resolve));
    const throwawayDb = new Database(':memory:');

    const exitCalls = [];
    let resolveExited;
    const exited = new Promise((resolve) => {
      resolveExited = resolve;
    });
    const fakeExit = (code) => {
      exitCalls.push(code);
      resolveExited();
    };

    const shutdown = installShutdownHandlers(throwawayServer, {
      db: throwawayDb,
      exit: fakeExit,
    });

    shutdown('SIGTERM');
    await exited;
    shutdown('SIGINT'); // second call: must not throw and must not call exit again

    expect(exitCalls).toEqual([0]);
  });
});

describe('startup registers signal handlers inside the require.main guard (AC5)', () => {
  it("process.on('SIGTERM'/'SIGINT') appear after require.main === module", () => {
    const src = fs.readFileSync(path.join(config.ROOT, 'src', 'app.js'), 'utf8');
    const guardIdx = src.indexOf('require.main === module');
    expect(guardIdx).not.toBe(-1);
    expect(src.indexOf("process.on('SIGTERM'")).toBeGreaterThan(guardIdx);
    expect(src.indexOf("process.on('SIGINT'")).toBeGreaterThan(guardIdx);
  });
});

describe('startup log advertises the public URL and carries no tunnel remnant (AC6)', () => {
  it('config.BASE_URL is logged inside the startup block, and no cloudflare string remains', () => {
    const src = fs.readFileSync(path.join(config.ROOT, 'src', 'app.js'), 'utf8');
    const guardIdx = src.indexOf('require.main === module');
    expect(guardIdx).not.toBe(-1);
    expect(src.indexOf('config.BASE_URL')).toBeGreaterThan(guardIdx);
    expect(/cloudflare/i.test(src)).toBe(false);
    expect(/trycloudflare/i.test(src)).toBe(false);
  });
});
