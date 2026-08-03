// tests/client-error-script.test.js
// Issue #1021 AC6: csrf.js then client-error.js render as non-deferred
// scripts in <head>, ahead of every stylesheet link, and footer.ejs no
// longer loads csrf.js -- plus client-error.js's own browser-side behavior
// (window.onerror/unhandledrejection registration, the 5-per-page-load cap,
// the 10s minimum interval, re-entry safety, and the fetch payload/headers
// it actually sends).
//
// Two halves: a supertest render check against the real app for the markup
// half of AC6 (any page renders partials/head.ejs the same way), and a jsdom
// fixture for the script's own runtime behavior -- same pattern
// tests/badge-moment-script.test.js uses (synthetic document, install
// window/document/fetch as globals, require the real script fresh, dispatch
// events, assert on a stubbed fetch's captured calls).
'use strict';

const { JSDOM } = require('jsdom');
const request = require('supertest');
const { loadApp, signInGuest } = require('./helpers/testApp');

const CLIENT_ERROR_JS_PATH = require.resolve('../src/public/js/client-error.js');
const CSRF_JS_PATH = require.resolve('../src/public/js/csrf.js');

// ---------------------------------------------------------------------------
// AC6, markup half: real rendered pages.
// ---------------------------------------------------------------------------
describe('AC6: <head> script order (rendered markup)', () => {
  let app;
  let db;

  beforeAll(() => {
    const loaded = loadApp();
    app = loaded.app;
    db = loaded.db;
  });

  /**
   * Both non-deferred <script> tags for csrf.js then client-error.js appear,
   * in that order, and both appear strictly before the first stylesheet
   * <link> -- so the handlers are registered before a CSS fetch (or any
   * later script) can ever run first.
   */
  function assertHeadScriptOrder(html) {
    const csrfIdx = html.indexOf('<script src="/js/csrf.js"></script>');
    const clientErrorIdx = html.indexOf('<script src="/js/client-error.js"></script>');
    const firstStylesheetIdx = html.indexOf('<link rel="stylesheet"');

    expect(csrfIdx).toBeGreaterThan(-1);
    expect(clientErrorIdx).toBeGreaterThan(-1);
    expect(firstStylesheetIdx).toBeGreaterThan(-1);

    expect(csrfIdx).toBeLessThan(clientErrorIdx);
    expect(clientErrorIdx).toBeLessThan(firstStylesheetIdx);

    // Neither carries a `defer` attribute -- a deferred load would run after
    // every non-deferred script on the page, missing exactly the top-level
    // parse-time throw this beacon exists to catch.
    expect(html).not.toMatch(/<script[^>]*\/js\/csrf\.js[^>]*defer/);
    expect(html).not.toMatch(/<script[^>]*\/js\/client-error\.js[^>]*defer/);
  }

  it('an anonymous page (GET /join) renders both scripts, in order, ahead of every stylesheet', async () => {
    const res = await request(app).get('/join');
    expect(res.status).toBe(200);
    assertHeadScriptOrder(res.text);
  });

  it('a 404 (message-card) page also renders both scripts -- head.ejs is included on every page', async () => {
    // A genuinely-unmatched path 404s only for a SIGNED-IN guest: for an
    // anonymous caller, the same path falls into src/routes/guest.js's
    // router.use(requireGuest) first (it gates every path routed through
    // it, matched or not) and comes back as a 302 to /join, never reaching
    // app.js's own 404 handler -- see that router's own comment.
    const token = `ce1021-404-${Date.now()}`;
    db.prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`).run(token, 'CE 404 Guest');
    const agent = signInGuest(app, token);

    const res = await agent.get('/this-route-does-not-exist');
    expect(res.status).toBe(404);
    assertHeadScriptOrder(res.text);
  });

  it('footer.ejs no longer loads csrf.js -- only one <script src="/js/csrf.js"> exists on the page, up in <head>', async () => {
    const res = await request(app).get('/join');
    const matches = res.text.match(/<script src="\/js\/csrf\.js">/g) || [];
    expect(matches.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Runtime behavior: jsdom fixture.
// ---------------------------------------------------------------------------

/**
 * Build a fresh jsdom document, install window/document/fetch as globals,
 * stub window.csrfHeader (the real csrf.js module IS required too, so this
 * exercises the real window.csrfHeader() the beacon actually calls), then
 * require client-error.js fresh so its top-level window.addEventListener
 * calls run against THIS document.
 * @returns {{window: Window, fetchCalls: Array<object>, restore: Function}}
 */
function loadClientError() {
  const dom = new JSDOM(
    '<!doctype html><html><head>' +
      '<meta name="csrf-token" content="test-token-abc">' +
      '</head><body></body></html>',
    { url: 'http://localhost/tasks/9' }
  );

  const fetchCalls = [];
  dom.window.fetch = function (url, opts) {
    fetchCalls.push({
      url: url,
      opts: opts,
      body: opts && opts.body ? JSON.parse(opts.body) : null,
    });
    return Promise.resolve({ ok: true, status: 204 });
  };

  const keys = ['window', 'document', 'fetch'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value: value, configurable: true, writable: true });
  });

  // Real script order: csrf.js's <script> tag renders before
  // client-error.js's in partials/head.ejs (AC6) -- require them in that
  // same order here.
  delete require.cache[CSRF_JS_PATH];
  require(CSRF_JS_PATH);
  delete require.cache[CLIENT_ERROR_JS_PATH];
  require(CLIENT_ERROR_JS_PATH);

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { window: dom.window, fetchCalls: fetchCalls, restore: restore };
}

function dispatchError(win, message, error) {
  const ev = new win.Event('error');
  ev.message = message;
  ev.error = error;
  win.dispatchEvent(ev);
}

function dispatchRejection(win, reason) {
  const ev = new win.Event('unhandledrejection');
  ev.reason = reason;
  win.dispatchEvent(ev);
}

describe('client-error.js: browser-side behavior', () => {
  it('registers window.onerror handling and POSTs message/stack/url with the real csrf header, immediately at load time', () => {
    const { window, fetchCalls, restore } = loadClientError();
    try {
      // A plain (Node-realm) Error, not window.Error -- client-error.js's
      // `reason instanceof Error` check (used by the unhandledrejection
      // handler below) resolves the bare `Error` identifier against the
      // realm the SCRIPT itself runs in (this jsdom fixture only swaps the
      // window/document/fetch globals, not Error), so a window.Error
      // instance would cross-realm-fail that check even though it would
      // pass in a real browser tab, where window.Error IS Error.
      const err = new Error('Cannot read properties of undefined');
      err.stack = 'TypeError: Cannot read properties of undefined\n    at foo (/js/x.js:1:1)';
      dispatchError(window, 'Uncaught TypeError: Cannot read properties of undefined', err);

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toBe('/client-error');
      expect(fetchCalls[0].opts.method).toBe('POST');
      expect(fetchCalls[0].opts.headers['X-CSRF-Token']).toBe('test-token-abc');
      expect(fetchCalls[0].body.message).toBe(
        'Uncaught TypeError: Cannot read properties of undefined'
      );
      expect(fetchCalls[0].body.stack).toBe(err.stack);
      expect(fetchCalls[0].body.url).toBe('http://localhost/tasks/9');
    } finally {
      restore();
    }
  });

  it('registers unhandledrejection handling and reports an Error reason with its message/stack', () => {
    const { window, fetchCalls, restore } = loadClientError();
    try {
      // Plain Error, not window.Error -- see the comment on the equivalent
      // line in the test above; this one's `instanceof Error` check is the
      // one that actually depends on it.
      const reason = new Error('promise blew up');
      reason.stack = 'Error: promise blew up\n    at bar (/js/y.js:2:2)';
      dispatchRejection(window, reason);

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].body.message).toBe('promise blew up');
      expect(fetchCalls[0].body.stack).toBe(reason.stack);
    } finally {
      restore();
    }
  });

  it('a non-Error rejection reason (a plain string/value) is coerced to a message with an empty stack, not dropped', () => {
    const { window, fetchCalls, restore } = loadClientError();
    try {
      dispatchRejection(window, 'plain string rejection');

      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].body.message).toBe('plain string rejection');
      expect(fetchCalls[0].body.stack).toBe('');
    } finally {
      restore();
    }
  });

  it('a plain resource-load error event (no event.message) is ignored, not reported', () => {
    const { window, fetchCalls, restore } = loadClientError();
    try {
      const ev = new window.Event('error');
      // No .message set -- the shape a broken <img>/<script> load fires,
      // per the real browser 'error' event on window.
      window.dispatchEvent(ev);

      expect(fetchCalls.length).toBe(0);
    } finally {
      restore();
    }
  });

  it('caps at 5 reports per page load -- a 6th error in the same load fires no further POST', () => {
    const { window, fetchCalls, restore } = loadClientError();
    try {
      const base = 1700000000000;
      vi.useFakeTimers();
      try {
        // Spaced past the 10s minimum interval so THAT guard never masks the
        // cap being tested here -- this test is about MAX_REPORTS, not the
        // interval floor (covered separately below).
        for (let i = 0; i < 6; i++) {
          vi.setSystemTime(base + i * 10000);
          dispatchError(window, 'flood ' + i, null);
        }
        expect(fetchCalls.length).toBe(5);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      restore();
    }
  });

  it('enforces a 10-second minimum interval between reports', () => {
    const { window, fetchCalls, restore } = loadClientError();
    try {
      const base = 1700000000000;
      vi.useFakeTimers();
      try {
        vi.setSystemTime(base);
        dispatchError(window, 'first', null);
        expect(fetchCalls.length).toBe(1);

        vi.setSystemTime(base + 5000); // 5s later -- still inside the 10s floor
        dispatchError(window, 'too soon', null);
        expect(fetchCalls.length).toBe(1);

        vi.setSystemTime(base + 10000); // exactly 10s later -- allowed
        dispatchError(window, 'after the floor', null);
        expect(fetchCalls.length).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      restore();
    }
  });

  it('is re-entry safe: an error dispatched from INSIDE the reporting path (synchronously, before the outer report finishes) does not itself fire a nested POST', () => {
    const { window, fetchCalls, restore } = loadClientError();
    try {
      let fetchCallCount = 0;
      // window.fetch, not global.fetch: client-error.js calls
      // `window.fetch(...)`, so reassigning the property this stub actually
      // reads from is what changes its behavior.
      window.fetch = function (url, opts) {
        fetchCallCount += 1;
        if (fetchCallCount === 1) {
          // Constructed, not a real browser path: this stub re-enters the
          // SAME error path synchronously, before the outer report() call has
          // thrown or returned, so `reporting` is still true when the nested
          // call arrives. No path from client-error.js's own code has been
          // found that reaches this shape from a real fetch throw -- see
          // DESIGN.md's "Client-error beacon" entry for the jsdom probe that
          // found `reporting` already false by the time a real synchronous
          // re-fire happens. Kept so a future refactor cannot make
          // `reporting` load-bearing without a test already covering it.
          dispatchError(window, 'nested, re-entrant crash', null);
        }
        fetchCalls.push({
          url: url,
          opts: opts,
          body: opts && opts.body ? JSON.parse(opts.body) : null,
        });
        return Promise.resolve({ ok: true, status: 204 });
      };

      dispatchError(window, 'original crash', null);

      // Only the OUTER call's fetch fires -- the re-entrant nested dispatch
      // must be swallowed by the reporting guard, not queued as a second
      // POST.
      expect(fetchCallCount).toBe(1);
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].body.message).toBe('original crash');
    } finally {
      restore();
    }
  });

  it('a synchronously-throwing fetch still records lastReportAt before the throw, so a rapid re-fire is blocked by the interval floor -- not by the reporting flag, which is already false by then', () => {
    const { window, restore } = loadClientError();
    try {
      let fetchCallCount = 0;
      window.fetch = function () {
        fetchCallCount += 1;
        throw new Error('fetch threw synchronously');
      };

      // The throw itself can trigger a real synchronous nested re-fire of
      // 'error' (a real browser reports an exception escaping an event
      // listener the same way) -- this single dispatch call already
      // exercises that path, not just the direct call.
      expect(() => dispatchError(window, 'first crash', null)).not.toThrow();
      expect(fetchCallCount).toBe(1);

      // Fired immediately after, well inside the 10s floor. This is the gap
      // a plausible future cleanup could open: if lastReportAt were assigned
      // only AFTER a successful fetch (e.g. "only record a report we
      // actually sent") instead of before the call, a throwing fetch would
      // never advance lastReportAt, the interval floor would never engage,
      // and this second dispatch -- along with every nested re-fire the
      // first one triggers -- would call fetch again, recursing until
      // MAX_REPORTS. Asserting exactly 1 here is what would catch that.
      expect(() => dispatchError(window, 'second crash', null)).not.toThrow();
      expect(fetchCallCount).toBe(1);
    } finally {
      restore();
    }
  });

  it('a failed fetch (network error) is swallowed -- no unhandled rejection escapes the page', async () => {
    const { window, restore } = loadClientError();
    try {
      // window.fetch -- see the comment on the equivalent reassignment in
      // the re-entry-safety test above.
      window.fetch = function () {
        return Promise.reject(new Error('network down'));
      };
      // Must not throw synchronously, and the returned (ignored) promise
      // must not surface as an unhandled rejection in THIS test process --
      // if .catch(function(){}) were missing, a real environment would log
      // an unhandled rejection here.
      expect(() => dispatchError(window, 'crash during outage', null)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      restore();
    }
  });
});
