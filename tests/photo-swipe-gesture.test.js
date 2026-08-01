// tests/photo-swipe-gesture.test.js
// Issue #928 — pinch-zoom and vertical scroll were flinging a guest onto the
// prev/next photo instead of letting them look closely (Goal D). The fix
// lives in src/public/js/photo.js's touch handlers, already rewritten and
// frozen by the phase-1 visual approval (see the issue file's header) — this
// is the only file phase 2 adds, covering AC1-AC5 by driving the REAL
// photo.js under jsdom.
//
// Pattern: build a synthetic document with the .js-photo-prev/.js-photo-next
// anchors src/views/photo.ejs renders, install window/document as globals,
// then require the real script fresh so its listeners bind to THIS document
// — the same jsdom-driven approach as tests/admin-tasks-script.test.js
// (see that file's own header; script-under-test path constant at its line
// 35, JSDOM construction at its line 474).
//
// One deliberate deviation from that precedent: `window` here is a plain
// stub object, not dom.window. photo.js's only two reads of `window` are
// `window.location.href = href` and `window.visualViewport` (src/public/js/
// photo.js:11,70) — neither needs a real browser window. Real jsdom Location
// objects are spec-unforgeable (own `href` property, configurable: false;
// confirmed in this worktree against jsdom 29.1.1 — Object.defineProperty
// and `delete` both fail silently/throw), and jsdom does not implement
// cross-document navigation at all (assigning `location.href` to a new path
// logs "Not implemented: navigation to another Document" and leaves the
// value unchanged) — so there is no way to observe which href the real
// window.location was set to. A plain stub `{ location: { href } }` gets
// written to exactly like the real one and lets each test assert the actual
// destination AC3 requires. Every touch event is still a real jsdom
// TouchEvent, registered and dispatched through the real jsdom Document —
// only the navigation side-effect's observation point is substituted.
//
// jsdom fires DOMContentLoaded asynchronously (a queued task), but photo.js's
// init() is registered to wait for it when readyState is 'loading' (which it
// is immediately after JSDOM parses a literal HTML string — confirmed in this
// worktree). Dispatching a synthetic DOMContentLoaded event right after
// require() invokes that listener synchronously, so the test stays
// synchronous instead of needing an awaited tick.
//
// The cost of that shortcut, and why teardown closes the window: jsdom's OWN
// DOMContentLoaded is still queued when the test body finishes. Once restore()
// has removed global.document, that queued event re-enters photo.js's init()
// and throws `ReferenceError: document is not defined` at photo.js:18 — the
// tests still pass, but the run prints one production-code stack trace per
// test to stderr, which is indistinguishable from a real photo.js regression
// to anyone triaging CI. dom.window.close() discards jsdom's pending task
// queue, so the real event never fires and the run is clean.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const PHOTO_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'photo.js');

const PREV_HREF = '/p/10'; // "Newer" — src/views/photo.ejs's js-photo-prev anchor
const NEXT_HREF = '/p/3'; // "Older" — src/views/photo.ejs's js-photo-next anchor
const PAGE_URL = 'http://localhost/p/5';

// Mirrors the two anchors src/views/photo.ejs renders inside
// <nav class="photo-pagination">, trimmed to just the selectors and hrefs
// photo.js's init() reads (issue #928's fixture has no need for the
// surrounding figure/caption markup that page also renders).
function pageMarkup() {
  return (
    '<a class="photo-prev js-photo-prev" href="' +
    PREV_HREF +
    '">&larr; Newer</a>' +
    '<a class="photo-next js-photo-next" href="' +
    NEXT_HREF +
    '">Older &rarr;</a>'
  );
}

/**
 * Build a fresh jsdom document carrying the prev/next anchors, install a
 * stub window + the real jsdom document as globals, then require the real
 * photo.js fresh so its listeners bind to THIS document (same load-order
 * contract src/views/partials/footer.ejs's pageScript tag establishes — set
 * for this page by src/routes/community.js:1068; it is non-deferred and sits
 * before </body>, so readyState is 'loading' when photo.js runs).
 */
function loadPhoto() {
  const dom = new JSDOM('<!doctype html><html><body>' + pageMarkup() + '</body></html>', {
    url: PAGE_URL,
  });

  // See file header: a plain stub, not dom.window — the real jsdom
  // Location's href cannot be observed once written.
  const stubWindow = { location: { href: PAGE_URL } };

  const keys = ['window', 'document'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
  });
  Object.defineProperty(global, 'window', {
    value: stubWindow,
    configurable: true,
    writable: true,
  });
  Object.defineProperty(global, 'document', {
    value: dom.window.document,
    configurable: true,
    writable: true,
  });

  delete require.cache[require.resolve(PHOTO_JS_PATH)];
  require(PHOTO_JS_PATH);

  // photo.js deferred init() to DOMContentLoaded (readyState is 'loading'
  // synchronously after JSDOM parses a literal string) — fire it now so the
  // listeners are bound before this function returns. See file header.
  if (dom.window.document.readyState === 'loading') {
    dom.window.document.dispatchEvent(
      new dom.window.Event('DOMContentLoaded', { bubbles: true, cancelable: true })
    );
  }

  function restore() {
    // Before the globals go away: discard jsdom's still-queued
    // DOMContentLoaded so it cannot re-enter init() post-teardown. See header.
    dom.window.close();
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return {
    doc: dom.window.document,
    TouchEvent: dom.window.TouchEvent,
    stubWindow,
    restore,
  };
}

// window.Touch is undefined in this jsdom (confirmed 29.1.1) — touch points
// are plain objects, matching what the real TouchEvent constructor here
// preserves on .touches/.changedTouches (also confirmed against the
// installed jsdom before writing this file).
function touchStart(ctx, points) {
  ctx.doc.dispatchEvent(
    new ctx.TouchEvent('touchstart', {
      touches: points,
      changedTouches: points,
      bubbles: true,
      cancelable: true,
    })
  );
}

function touchEnd(ctx, changedPoint, remainingTouches) {
  ctx.doc.dispatchEvent(
    new ctx.TouchEvent('touchend', {
      touches: remainingTouches || [],
      changedTouches: [changedPoint],
      bubbles: true,
      cancelable: true,
    })
  );
}

function touchCancel(ctx) {
  ctx.doc.dispatchEvent(
    new ctx.TouchEvent('touchcancel', {
      touches: [],
      changedTouches: [],
      bubbles: true,
      cancelable: true,
    })
  );
}

describe('photo.js swipe gesture (issue #928 — pinch/scroll must not fling navigation)', () => {
  test('AC1: releasing a pinch (second finger down disarms; the lifted finger carries a stale-origin dx > 40) does not navigate', () => {
    const ctx = loadPhoto();
    try {
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]); // finger 1 down, armed
      touchStart(ctx, [
        // finger 2 down: touches.length === 2 disarms outright
        { clientX: 100, clientY: 100 },
        { clientX: 140, clientY: 100 },
      ]);
      // One finger lifts; changedTouches carries a point far enough from the
      // original startX (100) to clear SWIPE_MIN_PX if armed were still true.
      touchEnd(ctx, { clientX: 200, clientY: 100 }, [{ clientX: 100, clientY: 100 }]);

      expect(ctx.stubWindow.location.href).toBe(PAGE_URL);
    } finally {
      ctx.restore();
    }
  });

  test('AC2: a single-finger drag whose vertical delta exceeds its horizontal delta (dx=45, dy=120) does not navigate', () => {
    const ctx = loadPhoto();
    try {
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]);
      touchEnd(ctx, { clientX: 145, clientY: 220 }); // dx=45, dy=120

      expect(ctx.stubWindow.location.href).toBe(PAGE_URL);
    } finally {
      ctx.restore();
    }
  });

  test('AC3a: a predominantly-horizontal swipe of dx=+80 navigates to the .js-photo-prev href', () => {
    const ctx = loadPhoto();
    try {
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]);
      touchEnd(ctx, { clientX: 180, clientY: 110 }); // dx=+80, dy=10

      expect(ctx.stubWindow.location.href).toBe(PREV_HREF);
    } finally {
      ctx.restore();
    }
  });

  test('AC3b: the mirrored swipe of dx=-80 navigates to the .js-photo-next href', () => {
    const ctx = loadPhoto();
    try {
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]);
      touchEnd(ctx, { clientX: 20, clientY: 110 }); // dx=-80, dy=10

      expect(ctx.stubWindow.location.href).toBe(NEXT_HREF);
    } finally {
      ctx.restore();
    }
  });

  test('AC4: a single-finger drag while the page is pinch-zoomed (visualViewport.scale > 1) pans instead of navigating', () => {
    const ctx = loadPhoto();
    try {
      ctx.stubWindow.visualViewport = { scale: 1.5 };
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]);
      // dx=80, dy=2 -- would clear both the distance and the axis guard at
      // normal zoom; the zoom guard must still block it.
      touchEnd(ctx, { clientX: 180, clientY: 102 });

      expect(ctx.stubWindow.location.href).toBe(PAGE_URL);
    } finally {
      ctx.restore();
    }
  });

  test('AC5: touchcancel disarms an in-progress gesture; a later touchend carrying dx=80 against the stale start coordinates does not navigate', () => {
    const ctx = loadPhoto();
    try {
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]);
      touchCancel(ctx);
      touchEnd(ctx, { clientX: 180, clientY: 105 }); // dx=80 against the stale startX=100

      expect(ctx.stubWindow.location.href).toBe(PAGE_URL);
    } finally {
      ctx.restore();
    }
  });

  // Boundary pair on SWIPE_MIN_PX (40px): the ACs above only exercise 80px
  // and 45px deltas, which would still pass even if the `< SWIPE_MIN_PX`
  // guard were mutated to `<= SWIPE_MIN_PX` or a nearby off-by-one. These
  // pin the exact threshold the way edge-case-checklist.md's "number: max
  // boundary" row asks for.
  test('boundary: dx exactly at the 40px threshold still navigates (the guard is a strict "<", not "<=")', () => {
    const ctx = loadPhoto();
    try {
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]);
      touchEnd(ctx, { clientX: 140, clientY: 105 }); // dx=40 exactly, dy=5

      expect(ctx.stubWindow.location.href).toBe(PREV_HREF);
    } finally {
      ctx.restore();
    }
  });

  test('boundary: dx one pixel under the 40px threshold does not navigate', () => {
    const ctx = loadPhoto();
    try {
      touchStart(ctx, [{ clientX: 100, clientY: 100 }]);
      touchEnd(ctx, { clientX: 139, clientY: 105 }); // dx=39, dy=5

      expect(ctx.stubWindow.location.href).toBe(PAGE_URL);
    } finally {
      ctx.restore();
    }
  });
});
