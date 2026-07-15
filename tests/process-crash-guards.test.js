// tests/process-crash-guards.test.js
// Issue #311 AC2: loading the app module registers a process-level
// unhandledRejection guard that LOGS rather than lets Node's default
// terminate-on-reject behavior run. Emits a synthetic unhandledRejection
// (the standard way to drive a registered process.on('unhandledRejection')
// listener without relying on real promise-microtask timing) and asserts the
// handler logged a line containing the literal "unhandledRejection".
'use strict';

const { loadApp } = require('./helpers/testApp');

beforeAll(() => {
  // Loading the app module is what registers the guard -- see src/app.js's
  // module-scope process.on('unhandledRejection'/'uncaughtException') block.
  loadApp();
});

describe('process-level unhandledRejection guard (issue #311 AC2)', () => {
  it('a registered handler logs a line containing "unhandledRejection" when one is emitted', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const reason = new Error('boom: synthetic unhandledRejection for AC2');
      // Directly emitting the event is the standard way to exercise a
      // registered process.on('unhandledRejection', ...) listener in a test
      // without depending on real promise-microtask scheduling; AC2 asks for
      // exactly this ("an unhandledRejection is emitted in test").
      process.emit('unhandledRejection', reason, Promise.resolve());

      const loggedUnhandledRejectionLine = consoleErrorSpy.mock.calls.some((args) =>
        args.some((a) => typeof a === 'string' && a.includes('unhandledRejection'))
      );
      expect(loggedUnhandledRejectionLine).toBe(true);

      // The reason itself was passed through to the logger, not swallowed.
      const loggedTheReason = consoleErrorSpy.mock.calls.some((args) => args.includes(reason));
      expect(loggedTheReason).toBe(true);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('src/app.js registers the guards at MODULE scope, before the require.main === module block (not inside it)', () => {
    const fs = require('fs');
    const path = require('path');
    const config = require('../config');
    const src = fs.readFileSync(path.join(config.ROOT, 'src', 'app.js'), 'utf8');

    const guardIdx = src.indexOf('require.main === module');
    const unhandledIdx = src.indexOf("process.on('unhandledRejection'");
    const uncaughtIdx = src.indexOf("process.on('uncaughtException'");

    expect(guardIdx).not.toBe(-1);
    expect(unhandledIdx).not.toBe(-1);
    expect(uncaughtIdx).not.toBe(-1);
    // Registered BEFORE the require.main guard -- runs on every require(), a
    // test's loadApp() included -- the opposite placement from SIGTERM/SIGINT
    // (tests/hosting-lifecycle.test.js AC5), which deliberately DO only run
    // for the real server process.
    expect(unhandledIdx).toBeLessThan(guardIdx);
    expect(uncaughtIdx).toBeLessThan(guardIdx);
  });
});
