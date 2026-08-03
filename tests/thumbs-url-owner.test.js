// tests/thumbs-url-owner.test.js
// Issue #1019: config.THUMBS_URL_BASE must be a real single owner of the
// public /thumbs URL mount prefix -- src/app.js's static mount,
// src/services/photos/paths.js's urlForThumb, and
// src/middleware/request-log.js's skip list must all move together when it
// changes, the same way tests/uploads-url-owner.test.js proves for
// config.UPLOADS_URL_BASE.
//
// AC1: config.THUMBS_URL_BASE === '/thumbs' (no trailing slash), matching
//      the pre-existing UPLOADS_URL_BASE convention.
// AC2: photos.urlForThumb derives its output from config.THUMBS_URL_BASE.
// AC3: changing config.THUMBS_URL_BASE before boot moves the app's static
//      mount to the new prefix -- proven by an actual HTTP round trip
//      against a freshly-booted app, not a source-string check.
// AC4: the same config change moves request-log's skip-prefix list, so a
//      request under the new prefix is skipped and a request under the OLD
//      '/thumbs' prefix (now unmounted, so it falls through to the guest
//      catch-all) is not silently treated as still-skipped.
//
// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js). AC3/AC4 additionally evict and
// re-require config/app/request-log/paths from Node's require.cache to
// force a fresh boot with a mutated config value -- same technique
// tests/hosting-lifecycle.test.js's reloadAppWithFreshConfig uses for
// TRUST_PROXY, and the module-cache-eviction technique
// tests/request-log.test.js's PUBLIC_DIR test already uses for this same
// middleware file.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { loadApp } = require('./helpers/testApp');

let config;
let photos;

beforeAll(() => {
  loadApp();
  config = require('../config');
  photos = require('../src/services/photos');
});

describe('config.THUMBS_URL_BASE (AC1)', () => {
  it('is the exact literal "/thumbs" with no trailing slash', () => {
    expect(config.THUMBS_URL_BASE).toBe('/thumbs');
  });
});

describe('photos.urlForThumb derives from config.THUMBS_URL_BASE (AC2)', () => {
  it('builds the public URL by prefixing the filename', () => {
    expect(photos.urlForThumb('abc.jpg')).toBe('/thumbs/abc.jpg');
  });

  it('stays byte-identical to config.THUMBS_URL_BASE + "/" + filename', () => {
    // Proves the builder is DERIVED from the config value, not a
    // coincidental match with a still-hardcoded literal: if a future edit
    // changed THUMBS_URL_BASE, this assertion (unlike a bare
    // '/thumbs/abc.jpg' string) would still pass while a hardcoded builder
    // would fail it.
    expect(photos.urlForThumb('abc.jpg')).toBe(config.THUMBS_URL_BASE + '/abc.jpg');
  });

  it('edge: empty input returns the empty string (falsy guard, unchanged)', () => {
    expect(photos.urlForThumb('')).toBe('');
  });
});

describe('changing config.THUMBS_URL_BASE moves the static mount, urlForThumb, and the request-log skip list together (AC3, AC4)', () => {
  const NEW_PREFIX = '/t1019';

  it('a fresh boot with THUMBS_URL_BASE mutated serves under the new prefix, drops the old one, and skips logging only the new one', async () => {
    const configPath = require.resolve('../config');
    const appPath = require.resolve('../src/app');
    const requestLogPath = require.resolve('../src/middleware/request-log');
    const pathsPath = require.resolve('../src/services/photos/paths');
    const photosPath = require.resolve('../src/services/photos');

    try {
      // 1. Evict config and everything downstream of it that this test cares
      //    about, then re-require config fresh and mutate the one field
      //    under test -- the same singleton-object-mutation technique
      //    tests/hosting-lifecycle.test.js uses, except THUMBS_URL_BASE has
      //    no env override (unlike TRUST_PROXY), so the mutation happens
      //    directly on the freshly-required object instead of via
      //    process.env before require.
      delete require.cache[configPath];
      delete require.cache[appPath];
      delete require.cache[requestLogPath];
      delete require.cache[pathsPath];
      delete require.cache[photosPath];

      const freshConfig = require('../config');
      freshConfig.THUMBS_URL_BASE = NEW_PREFIX;

      // Put a real file under the (unchanged) THUMBS_DIR so a request to the
      // new mount has something to actually serve.
      fs.mkdirSync(freshConfig.THUMBS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(freshConfig.THUMBS_DIR, '0123456789abcdef-1.jpg.jpg'),
        'thumb-bytes'
      );

      // 2. Re-require app.js -- this pulls in the fresh, mutated config and
      //    a fresh request-log.js, so both the static mount and the skip
      //    list are built from NEW_PREFIX.
      const freshApp = require('../src/app');
      const freshPhotos = require('../src/services/photos');

      // AC2 continued: urlForThumb on the fresh module also derives from
      // the mutated value.
      expect(freshPhotos.urlForThumb('0123456789abcdef-1.jpg.jpg')).toBe(
        NEW_PREFIX + '/0123456789abcdef-1.jpg.jpg'
      );

      // AC3: the static mount actually moved -- the new prefix serves the
      // real file (200), the old '/thumbs' prefix is no longer mounted at
      // all and falls through to the guest catch-all's unauthenticated
      // redirect (302 to /join), not a 404 from the (now-gone) thumbs mount.
      const newPrefixRes = await request(freshApp).get(NEW_PREFIX + '/0123456789abcdef-1.jpg.jpg');
      expect(newPrefixRes.status).toBe(200);
      // .jpg serves as image/jpeg -- supertest only fills in `.text` for
      // text-based content types, so compare the raw bytes via `.body`.
      expect(Buffer.from(newPrefixRes.body).toString('utf8')).toBe('thumb-bytes');

      const oldPrefixRes = await request(freshApp).get('/thumbs/0123456789abcdef-1.jpg.jpg');
      expect(oldPrefixRes.status).toBe(302);
      expect(oldPrefixRes.headers.location).toBe('/join');

      // AC4: request-log's skip list moved with it. Force LOG_ALL_REQUESTS
      // so a request that is NOT skipped is guaranteed to log, making
      // silence under the new prefix proof of the skip list, not
      // coincidence.
      freshConfig.LOG_ALL_REQUESTS = true;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        await request(freshApp).get(NEW_PREFIX + '/0123456789abcdef-1.jpg.jpg');
        const lines = logSpy.mock.calls
          .map((args) => args[0])
          .map((raw) => {
            try {
              return JSON.parse(raw);
            } catch {
              return null;
            }
          })
          .filter((parsed) => parsed !== null);
        expect(lines.length).toBe(0);
      } finally {
        logSpy.mockRestore();
        freshConfig.LOG_ALL_REQUESTS = false;
      }
    } finally {
      // Restore every evicted module to reflect the real config before any
      // later test in this file (or another file sharing this process)
      // re-requires it -- same cleanup discipline
      // tests/hosting-lifecycle.test.js's reloadAppWithFreshConfig and
      // tests/request-log.test.js's PUBLIC_DIR test both follow.
      delete require.cache[configPath];
      delete require.cache[appPath];
      delete require.cache[requestLogPath];
      delete require.cache[pathsPath];
      delete require.cache[photosPath];
      require('../src/app');
    }
  });
});
