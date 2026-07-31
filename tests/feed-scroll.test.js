// tests/feed-scroll.test.js
// Covers issue #677 — bidirectional in-place loading for the full-screen
// /feed. src/public/js/feed-scroll.js, the sentinels/indicators/pager
// classes in src/views/feed.ejs, and the theme.css rules were owner-approved
// and phase-1 frozen 2026-07-29; a PR review round on the phase-2 branch
// found real defects in the frozen module and was authorized to fix them in
// place: a scroll-anchoring redesign (a toggled body.feed-inserting class
// replaces a static, page-leaking overflow-anchor:none), a dead-field
// rename (appended/prepended -> inserted), a cross-edge stall (the in-flight
// guard is now per-edge, not shared), a window.fetch/bare-fetch mismatch,
// plus one theme.css ring-geometry dedupe and one feed.ejs assistive-tech
// fix. All of it is captured in the tests below and in DESIGN.md's #677
// entry. Structure mirrors tests/gallery-show-more.test.js (issue #610's
// sibling module, gallery-more.js).
//
//   liftFeedItems(doc, feedEl) / appendOlder / prependNewer — unit, against
//   jsdom documents built directly (prior art: tests/gallery-show-more.test.js's
//   appendNextPage tests):
//     - liftFeedItems throws when the fetched document has no .feed
//     - liftFeedItems returns only the fetched tiles NOT already in the live
//       feed, in document order, plus the fetched page's own newerHref/olderHref
//     - a fetched tile with no id is never treated as a duplicate
//     - appendOlder appends below, in order, and count grows (`.inserted`);
//       nextHref advances or goes null on the last window; overlap is skipped
//     - prependNewer prepends above, count grows (`.inserted`); nextHref
//       advances or goes null on the newest window
//     - prependNewer's third parameter is an injectable scrollBy hook: it is
//       called with the delta between the anchor tile's pre- and post-insert
//       position (AC2's "the photo the guest was viewing stays put"), and is
//       NOT called when nothing was actually inserted (full overlap)
//     - AC2: prepending a page that overlaps the live feed (shared
//       photo-<id>s) inserts only the unseen tiles — no duplicate DOM ids
//
//   wireUpFeedScroll() — wire-level, jsdom + a stubbed fetch AND a stubbed
//   IntersectionObserver (jsdom implements neither, which is exactly why
//   feed-scroll.js's own capability guard checks for both before wiring —
//   prior art for the fetch-stub/global-install technique:
//   tests/gallery-show-more.test.js's installDomGlobals/deferredFetch):
//     - wiring hides the no-JS pager nav (the feed reads as one surface)
//     - the loading indicator is hidden by default, shown while a fetch is
//       in flight, and removed once the fetched batch is inserted
//     - a second trigger at the SAME edge while its own fetch is still in
//       flight fires no second fetch
//     - a trigger at the OTHER edge while one edge's fetch is in flight
//       proceeds independently and both inserts land — the in-flight guard
//       is per-edge, not shared, so scrolling toward one end never stalls
//       behind a still-resolving fetch at the other end
//     - a rejected fetch, and separately a non-200 fetch, both: hide the
//       indicator, insert nothing, never navigate (AC5 — an auto-triggered
//       failure must not yank the guest off their photo, unlike #610's
//       tap-driven fallback), and leave the edge armed so the next
//       intersection retries
//     - an edge retires (older AND newer) when the fetched page's own pager
//       carries no further href in that direction: the indicator stays
//       hidden, the sentinel is unobserved, and no further fetch fires
//     - document.body carries .feed-inserting for exactly the tick that
//       processes one insert (native CSS scroll anchoring is suppressed
//       only for that tick — see theme.css's body.feed-inserting rule and
//       DESIGN.md's #677 entry), and it is cleared again once the tick
//       settles — including when edge.insert() itself throws
//
//   Server-shape — supertest against the real /feed route (prior art:
//   tests/feed-card.test.js, tests/gallery-show-more.test.js's own server
//   describe): a window with both a newer and an older page ahead of it
//   includes /js/feed-scroll.js, both page-link-newer/page-link-older
//   controls, and all four sentinel/indicator elements, each indicator
//   carrying role="status" and its own visually-hidden loading text; the
//   newest window (no anchor) includes only the older half; a single-window
//   feed (fewer than a page of photos) includes none of it.
//
// TWO INDEPENDENT APP BOOTS, ONE FILE: the server-shape section needs two
// genuinely different total submission counts (over a page, and under one) —
// a property of the WHOLE feed, not of one window, so one seeded database
// cannot produce both shapes. Every other test file in this suite calls
// loadApp() exactly once (tests/avatar-initials.test.js's own comment: "a
// second loadApp() would return the same cached modules"), because
// loadApp()'s fresh DATA_DIR/DB_PATH env vars only take effect on modules
// require() has not already cached. evictAppModules() below generalizes the
// documented fix (tests/hosting-lifecycle.test.js's reloadAppWithFreshConfig,
// tests/flash-migration.test.js's bootFreshDb: evict from require.cache
// directly, since vi.resetModules() does not touch a plain CommonJS
// require()) from just config.js/db.js to the WHOLE src/ tree, so the second
// loadApp() call re-executes app.js and every route/service module it pulls
// in — not just db.js — against the second temp database.
//
// REQUIRE ORDER: config / db / app are required only via loadApp() (or after
// evictAppModules() + loadApp()) — see loadApp's own doc comment.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');
const request = require('supertest');
const {
  liftFeedItems,
  appendOlder,
  prependNewer,
  wireUpFeedScroll,
} = require('../src/public/js/feed-scroll');
const { loadApp, signInGuest } = require('./helpers/testApp');

// ---------------------------------------------------------------------------
// Shared markup builders — a feed tile carries id="photo-<n>" and class
// "feed-item", matching src/views/feed.ejs's <article id="photo-<%= p.submission_id %>"
// class="feed-item"> exactly (liftFeedItems keys its dedupe off that id).
// ---------------------------------------------------------------------------

function feedItemMarkup(n) {
  return `<article id="photo-${n}" class="feed-item" data-tile="${n}"></article>`;
}

/** The live .feed container the helpers append/prepend into. */
function liveFeed(ids) {
  const doc = new JSDOM(`<div class="feed">${ids.map(feedItemMarkup).join('')}</div>`).window
    .document;
  return doc.querySelector('.feed');
}

/** A parsed "fetched /feed page" document: a .feed plus an optional pager. */
function feedPageDocument({ ids, newerHref = null, olderHref = null }) {
  const items = ids.map(feedItemMarkup).join('');
  const newerLink = newerHref
    ? `<a class="page-link page-link-newer" href="${newerHref}">&larr; Newer</a>`
    : '';
  const olderLink = olderHref
    ? `<a class="page-link page-link-older" href="${olderHref}">Older &rarr;</a>`
    : '';
  const nav =
    newerHref || olderHref
      ? `<nav class="pagination" aria-label="Feed pages">${newerLink}${olderLink}</nav>`
      : '';
  const html = `<div class="feed">${items}</div>${nav}`;
  return new JSDOM(html).window.document;
}

// ---------------------------------------------------------------------------
// liftFeedItems(doc, feedEl) — pure DOM lift, no globals required.
// ---------------------------------------------------------------------------
describe('liftFeedItems: lifts the unseen tiles out of a fetched /feed document', () => {
  it('throws when the fetched document has no .feed', () => {
    const feedEl = liveFeed([1]);
    const doc = new JSDOM('<p>not a feed page</p>').window.document;

    expect(() => liftFeedItems(doc, feedEl)).toThrow(/feed/);
  });

  it('returns only the fetched tiles NOT already in the live feed, in document order', () => {
    const feedEl = liveFeed([3, 4]);
    const doc = feedPageDocument({ ids: [1, 2, 3] });

    const result = liftFeedItems(doc, feedEl);

    expect(result.items.map((el) => el.id)).toEqual(['photo-1', 'photo-2']);
  });

  it("reads the fetched page's own newerHref/olderHref, null when its pager is absent", () => {
    const feedEl = liveFeed([1]);
    const withPager = feedPageDocument({ ids: [2], newerHref: '/feed', olderHref: '/feed?from=3' });
    expect(liftFeedItems(withPager, feedEl)).toMatchObject({
      newerHref: '/feed',
      olderHref: '/feed?from=3',
    });

    const withoutPager = feedPageDocument({ ids: [2] });
    expect(liftFeedItems(withoutPager, feedEl)).toMatchObject({ newerHref: null, olderHref: null });
  });

  it('a fetched tile with no id is never treated as a duplicate', () => {
    const feedEl = liveFeed([1]);
    const doc = new JSDOM(
      '<div class="feed"><article class="feed-item" data-tile="ghost"></article></div>'
    ).window.document;

    const result = liftFeedItems(doc, feedEl);

    expect(result.items.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// appendOlder(doc, feedEl) — the bottom-edge insert.
// ---------------------------------------------------------------------------
describe('appendOlder: appends the next-older window below the live feed', () => {
  it('appends the fetched tiles after the existing ones, in order, and the count grows', () => {
    const feedEl = liveFeed([1, 2]);
    const doc = feedPageDocument({ ids: [3, 4, 5], olderHref: '/feed?from=6' });

    const result = appendOlder(doc, feedEl);

    expect(result.inserted).toBe(3);
    expect([...feedEl.querySelectorAll('.feed-item')].map((el) => el.id)).toEqual([
      'photo-1',
      'photo-2',
      'photo-3',
      'photo-4',
      'photo-5',
    ]);
    expect(result.nextHref).toBe('/feed?from=6');
  });

  it('nextHref is null when the fetched page has no older link (the last window)', () => {
    const feedEl = liveFeed([1]);
    const doc = feedPageDocument({ ids: [2] });

    const result = appendOlder(doc, feedEl);

    expect(result.nextHref).toBeNull();
  });

  it('skips a fetched tile whose id already exists in the live feed — no duplicate', () => {
    const feedEl = liveFeed([1, 2]);
    const doc = feedPageDocument({ ids: [2, 3] });

    const result = appendOlder(doc, feedEl);

    expect(result.inserted).toBe(1);
    const ids = [...feedEl.querySelectorAll('.feed-item')].map((el) => el.id);
    expect(ids).toEqual(['photo-1', 'photo-2', 'photo-3']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// prependNewer(doc, feedEl, scrollBy) — the top-edge insert, with the
// scroll-jump correction (AC2).
// ---------------------------------------------------------------------------
describe('prependNewer: prepends the next-newer window above the live feed without a visual jump', () => {
  it('prepends the fetched tiles before the existing ones, in order, and the count grows', () => {
    const feedEl = liveFeed([5]);
    const doc = feedPageDocument({ ids: [3, 4], newerHref: '/feed?from=2' });

    const result = prependNewer(doc, feedEl, () => {});

    expect(result.inserted).toBe(2);
    expect([...feedEl.querySelectorAll('.feed-item')].map((el) => el.id)).toEqual([
      'photo-3',
      'photo-4',
      'photo-5',
    ]);
    expect(result.nextHref).toBe('/feed?from=2');
  });

  it('nextHref is null when the fetched page has no newer link (the newest window is loaded)', () => {
    const feedEl = liveFeed([5]);
    const doc = feedPageDocument({ ids: [3, 4] });

    const result = prependNewer(doc, feedEl, () => {});

    expect(result.nextHref).toBeNull();
  });

  it("calls the injected scrollBy hook with the delta between the anchor tile's pre- and post-insert position", () => {
    const feedEl = liveFeed([5]);
    const doc = feedPageDocument({ ids: [3, 4] });
    const anchor = feedEl.firstElementChild; // the tile the guest was viewing
    let measureCount = 0;
    // jsdom performs no real layout, so getBoundingClientRect is stubbed
    // directly on the anchor: the FIRST call (before insert) reports the
    // guest's photo at the top; the SECOND (after two tiles land above it)
    // reports it pushed down 240px — exactly the jump prependNewer must
    // correct by scrolling the page down that same 240px so the photo the
    // guest was viewing stays visually in place.
    anchor.getBoundingClientRect = () => {
      measureCount += 1;
      return { top: measureCount === 1 ? 0 : 240 };
    };
    const scrollByCalls = [];

    prependNewer(doc, feedEl, (x, y) => scrollByCalls.push([x, y]));

    expect(scrollByCalls).toEqual([[0, 240]]);
  });

  it('does not call scrollBy when nothing was inserted (every fetched tile already lives in the feed)', () => {
    const feedEl = liveFeed([5]);
    const doc = feedPageDocument({ ids: [5] }); // full overlap
    const scrollByCalls = [];

    const result = prependNewer(doc, feedEl, (x, y) => scrollByCalls.push([x, y]));

    expect(result.inserted).toBe(0);
    expect(scrollByCalls.length).toBe(0);
  });

  it('AC2: prepending a page that overlaps the live feed inserts only the unseen tiles — no duplicate DOM ids', () => {
    const feedEl = liveFeed([3, 4, 5]);
    // The newer chain's final window is the first page, which overlaps the
    // live window when fewer than a full FEED_PAGE_SIZE of newer photos
    // remain (issue #677 AC2) — 3 and 4 are already live; only 1 and 2 are new.
    const doc = feedPageDocument({ ids: [1, 2, 3, 4] });

    const result = prependNewer(doc, feedEl, () => {});

    expect(result.inserted).toBe(2);
    const ids = [...feedEl.querySelectorAll('.feed-item')].map((el) => el.id);
    expect(ids).toEqual(['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5']);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ---------------------------------------------------------------------------
// wireUpFeedScroll() — wire-level, a stubbed IntersectionObserver driving a
// stubbed fetch. jsdom (29.1.1) implements neither IntersectionObserver nor
// fetch, matching feed-scroll.js's own capability guard, which is exactly
// why real browser behavior must be simulated rather than relied on.
// ---------------------------------------------------------------------------

/** Records every IntersectionObserver instance so a test can drive its callback directly. */
function stubIntersectionObserverClass() {
  const instances = [];
  class StubIntersectionObserver {
    constructor(callback) {
      this.callback = callback;
      this.targets = [];
      instances.push(this);
    }
    observe(target) {
      if (this.targets.indexOf(target) === -1) {
        this.targets.push(target);
      }
    }
    unobserve(target) {
      this.targets = this.targets.filter((t) => t !== target);
    }
    disconnect() {
      this.targets = [];
    }
    /** Simulate `target` crossing into the rootMargin. */
    trigger(target) {
      this.callback([{ isIntersecting: true, target }]);
    }
  }
  return { StubIntersectionObserver, instances };
}

/**
 * A fetch stub whose promise the test resolves/rejects by hand, so a test
 * can observe the "request in flight" state before deciding what the server
 * answered (same technique as tests/gallery-show-more.test.js's deferredFetch).
 */
function deferredFetch() {
  let settle;
  const calls = [];
  const stub = function (url) {
    calls.push(url);
    return new Promise((resolve, reject) => {
      settle = { resolve, reject };
    });
  };
  stub.calls = calls;
  stub.resolveWith = (html) =>
    settle.resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
  stub.resolveNotOk = (status) =>
    settle.resolve({ ok: false, status, text: () => Promise.resolve('') });
  stub.rejectWith = (err) => settle.reject(err || new Error('network down'));
  return stub;
}

/**
 * A fetch stub that tracks EVERY call's own resolve/reject pair by call
 * index, so a test can hold two (or more) requests in flight at once and
 * settle each independently, in either order — deferredFetch above only
 * remembers the latest call's pending pair, which a second concurrent call
 * would silently clobber. Used by the FIX 3 cross-edge test, where the
 * newer and older edges' fetches are genuinely concurrent.
 */
function concurrentFetch() {
  const calls = [];
  const pending = [];
  const stub = function (url) {
    calls.push(url);
    return new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
  };
  stub.calls = calls;
  stub.resolveCallWith = (index, html) =>
    pending[index].resolve({ ok: true, status: 200, text: () => Promise.resolve(html) });
  stub.resolveCallNotOk = (index, status) =>
    pending[index].resolve({ ok: false, status, text: () => Promise.resolve('') });
  stub.rejectCallWith = (index, err) => pending[index].reject(err || new Error('network down'));
  return stub;
}

/** Let every already-queued microtask (and one macrotask turn) run. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A live /feed page's DOM: the .feed container, the sentinel/indicator pair
 * for each edge that has a next href (same conditional as feed.ejs), and the
 * pager nav feed-scroll.js reads as the source of truth for hrefs.
 */
function buildLiveDom({ ids, newerHref = null, olderHref = null }) {
  const items = ids.map(feedItemMarkup).join('');
  const top = newerHref
    ? '<div class="feed-sentinel" id="feedSentinelNewer" aria-hidden="true"></div>' +
      '<div class="feed-edge" id="feedEdgeNewer" hidden aria-hidden="true"><span class="feed-edge-ring"></span></div>'
    : '';
  const bottom = olderHref
    ? '<div class="feed-edge" id="feedEdgeOlder" hidden aria-hidden="true"><span class="feed-edge-ring"></span></div>' +
      '<div class="feed-sentinel" id="feedSentinelOlder" aria-hidden="true"></div>'
    : '';
  const newerLink = newerHref
    ? `<a class="page-link page-link-newer" href="${newerHref}">&larr; Newer</a>`
    : '';
  const olderLink = olderHref
    ? `<a class="page-link page-link-older" href="${olderHref}">Older &rarr;</a>`
    : '';
  const nav =
    newerHref || olderHref
      ? `<nav class="pagination" aria-label="Feed pages">${newerLink}${olderLink}</nav>`
      : '';
  const html = `${top}<div class="feed">${items}</div>${bottom}${nav}`;
  return new JSDOM(html, { url: 'http://localhost/feed' });
}

// Point window/document/navigator/IntersectionObserver at a fresh jsdom
// instance, same Object.defineProperty technique as
// tests/gallery-show-more.test.js's installDomGlobals (newer Node defines
// global.navigator as getter-only). fetch/IntersectionObserver are set on
// dom.window itself, not the bare Node global — feed-scroll.js's capability
// guard AND its fetch() call both read `window.fetch` (#677 PR review fix:
// the call used to read the bare `fetch` identifier while the guard read
// `window.fetch`; this file used to also stub a bare `global.fetch`, which
// happened to mask that mismatch — now that the call reads `window.fetch`
// too, `dom.window.fetch` below is the only fetch stub that matters).
// DOMParser is the one remaining exception: the guard checks
// `window.DOMParser`, but the actual `new DOMParser()` call still reads the
// bare identifier, so `global.DOMParser` stays set.
function installDomGlobals(dom, fetchStub, IntersectionObserverClass) {
  const descriptorKeys = ['window', 'document', 'navigator'];
  const saved = {};
  descriptorKeys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  });
  const savedDOMParser = global.DOMParser;
  global.DOMParser = dom.window.DOMParser;
  dom.window.fetch = fetchStub;
  dom.window.IntersectionObserver = IntersectionObserverClass;

  return function restore() {
    descriptorKeys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
    global.DOMParser = savedDOMParser;
  };
}

describe('wireUpFeedScroll: scroll-driven fetch, stubbed IntersectionObserver + fetch', () => {
  it('hides the no-JS pager nav once wired (the feed reads as one continuous surface)', () => {
    const dom = buildLiveDom({ ids: [1], olderHref: '/feed?from=2' });
    const { StubIntersectionObserver } = stubIntersectionObserverClass();
    const restore = installDomGlobals(dom, deferredFetch(), StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      expect(dom.window.document.querySelector('.pagination').hidden).toBe(true);
    } finally {
      restore();
    }
  });

  it('shows the loading indicator while the fetch is in flight, and removes it once the batch is inserted', async () => {
    const dom = buildLiveDom({ ids: [1], olderHref: '/feed?from=2' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const sentinel = doc.getElementById('feedSentinelOlder');
      const indicator = doc.getElementById('feedEdgeOlder');
      expect(indicator.hidden).toBe(true);

      instances[0].trigger(sentinel);
      expect(indicator.hidden).toBe(false);

      fetchStub.resolveWith(
        `<div class="feed">${feedItemMarkup(2)}${feedItemMarkup(3)}</div>` +
          '<nav class="pagination"><a class="page-link page-link-older" href="/feed?from=4">Older</a></nav>'
      );
      await flushMicrotasks();

      expect(indicator.hidden).toBe(true);
      expect(doc.querySelectorAll('.feed-item').length).toBe(3);
    } finally {
      restore();
    }
  });

  it('a second trigger at the SAME edge while its own fetch is still in flight fires no second fetch', async () => {
    const dom = buildLiveDom({ ids: [1], olderHref: '/feed?from=2' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const sentinel = dom.window.document.getElementById('feedSentinelOlder');

      instances[0].trigger(sentinel);
      instances[0].trigger(sentinel);

      expect(fetchStub.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('FIX 3: a trigger at the OTHER edge proceeds independently while this edge is still in flight — both settle and both inserts land', async () => {
    const dom = buildLiveDom({ ids: [3], newerHref: '/feed?from=2', olderHref: '/feed?from=4' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    // A concurrentFetch, not deferredFetch: this test needs TWO in-flight
    // requests resolvable independently and in either order — deferredFetch
    // only tracks ONE pending resolve/reject pair, which a second concurrent
    // call would silently overwrite.
    const fetchStub = concurrentFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const newerSentinel = doc.getElementById('feedSentinelNewer');
      const olderSentinel = doc.getElementById('feedSentinelOlder');

      instances[0].trigger(newerSentinel); // call 0: newer, left in flight
      expect(fetchStub.calls.length).toBe(1);

      // Under the old SHARED `inFlight` boolean this would have been
      // dropped — the per-edge guard (edge.inFlight) lets the older edge's
      // own fetch proceed regardless of the newer edge's state.
      instances[0].trigger(olderSentinel); // call 1: older
      expect(fetchStub.calls.length).toBe(2);

      // Settle out of trigger order (older first) to prove neither edge's
      // completion depends on the other's.
      fetchStub.resolveCallWith(
        1,
        `<div class="feed">${feedItemMarkup(4)}${feedItemMarkup(5)}</div>`
      );
      await flushMicrotasks();
      fetchStub.resolveCallWith(
        0,
        `<div class="feed">${feedItemMarkup(1)}${feedItemMarkup(2)}</div>`
      );
      await flushMicrotasks();

      const ids = [...doc.querySelectorAll('.feed-item')].map((el) => el.id);
      expect(ids).toEqual(['photo-1', 'photo-2', 'photo-3', 'photo-4', 'photo-5']);
    } finally {
      restore();
    }
  });

  it('AC5: a rejected fetch removes the indicator, inserts nothing, never navigates, and leaves the edge retryable', async () => {
    const dom = buildLiveDom({ ids: [1], olderHref: '/feed?from=2' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const sentinel = doc.getElementById('feedSentinelOlder');
      const indicator = doc.getElementById('feedEdgeOlder');

      instances[0].trigger(sentinel);
      fetchStub.rejectWith(new Error('network down'));
      await flushMicrotasks();

      expect(indicator.hidden).toBe(true);
      expect(doc.querySelectorAll('.feed-item').length).toBe(1); // nothing inserted
      expect(dom.window.location.href).toBe('http://localhost/feed'); // never navigated

      // Retryable: the edge stayed armed, so the next intersection fetches again.
      instances[0].trigger(sentinel);
      expect(fetchStub.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  it('AC5: a non-200 fetch behaves the same as a rejected one — indicator cleared, edge retryable', async () => {
    const dom = buildLiveDom({ ids: [1], olderHref: '/feed?from=2' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const sentinel = doc.getElementById('feedSentinelOlder');
      const indicator = doc.getElementById('feedEdgeOlder');

      instances[0].trigger(sentinel);
      fetchStub.resolveNotOk(500);
      await flushMicrotasks();

      expect(indicator.hidden).toBe(true);
      expect(doc.querySelectorAll('.feed-item').length).toBe(1);

      instances[0].trigger(sentinel);
      expect(fetchStub.calls.length).toBe(2);
    } finally {
      restore();
    }
  });

  it('the older edge retires when its fetched page carries no further older link: indicator hidden, unobserved, no further fetch', async () => {
    const dom = buildLiveDom({ ids: [1], olderHref: '/feed?from=2' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const sentinel = doc.getElementById('feedSentinelOlder');
      const indicator = doc.getElementById('feedEdgeOlder');

      instances[0].trigger(sentinel);
      // The fetched page's own pager carries no older link — this was the last window.
      fetchStub.resolveWith(`<div class="feed">${feedItemMarkup(2)}</div>`);
      await flushMicrotasks();

      expect(indicator.hidden).toBe(true);
      expect(instances[0].targets).not.toContain(sentinel);

      instances[0].trigger(sentinel); // a stray trigger after retirement fetches nothing further
      expect(fetchStub.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('the newer edge retires the same way when its fetched page carries no further newer link', async () => {
    const dom = buildLiveDom({ ids: [5], newerHref: '/feed?from=4' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const sentinel = doc.getElementById('feedSentinelNewer');
      const indicator = doc.getElementById('feedEdgeNewer');

      instances[0].trigger(sentinel);
      // No newer link in the fetched page's own pager — the newest photo is loaded.
      fetchStub.resolveWith(`<div class="feed">${feedItemMarkup(6)}</div>`);
      await flushMicrotasks();

      expect(indicator.hidden).toBe(true);
      expect(instances[0].targets).not.toContain(sentinel);

      instances[0].trigger(sentinel);
      expect(fetchStub.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('FIX 1: suppresses native scroll anchoring (body.feed-inserting) for exactly the tick that processes the insert', async () => {
    const dom = buildLiveDom({ ids: [5], newerHref: '/feed?from=4' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const sentinel = doc.getElementById('feedSentinelNewer');
      // prependNewer measures this anchor tile's position twice — once
      // before the insert, once after — both calls happen synchronously
      // INSIDE load()'s window between adding and clearing the class, so
      // stubbing getBoundingClientRect is a window onto whether the class
      // was really present at the moment the module needed it suppressed.
      const anchor = doc.querySelector('.feed').firstElementChild;
      const observedDuringInsert = [];
      anchor.getBoundingClientRect = () => {
        observedDuringInsert.push(doc.body.classList.contains('feed-inserting'));
        return { top: 0 };
      };

      expect(doc.body.classList.contains('feed-inserting')).toBe(false);

      instances[0].trigger(sentinel);
      fetchStub.resolveWith(
        `<div class="feed">${feedItemMarkup(6)}</div>` +
          '<nav class="pagination"><a class="page-link page-link-newer" href="/feed?from=7">Newer</a></nav>'
      );
      await flushMicrotasks();

      // Both measurements (pre- and post-insert) ran while suppressed.
      expect(observedDuringInsert).toEqual([true, true]);
      // jsdom has no requestAnimationFrame, so clearInsertingSoon's
      // synchronous fallback already ran — the class is not left stuck on,
      // which would silently re-break native anchoring for the rest of the
      // page's life (the exact failure mode this fix replaces).
      expect(doc.body.classList.contains('feed-inserting')).toBe(false);
    } finally {
      restore();
    }
  });

  it('FIX 1: clears feed-inserting even when edge.insert() itself throws (unexpected fetched markup)', async () => {
    const dom = buildLiveDom({ ids: [1], olderHref: '/feed?from=2' });
    const { StubIntersectionObserver, instances } = stubIntersectionObserverClass();
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub, StubIntersectionObserver);
    try {
      wireUpFeedScroll();
      const doc = dom.window.document;
      const sentinel = doc.getElementById('feedSentinelOlder');

      instances[0].trigger(sentinel);
      // No .feed in the fetched markup — liftFeedItems throws (via
      // appendOlder), caught by load()'s catch AFTER the class was added.
      fetchStub.resolveWith('<p>not a feed page</p>');
      await flushMicrotasks();

      expect(doc.body.classList.contains('feed-inserting')).toBe(false);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Server-rendered shape — GET /feed via supertest against the real app. See
// this file's header comment for why two independent app boots are needed.
// ---------------------------------------------------------------------------

const SRC_ROOT_PREFIX = path.resolve(__dirname, '..', 'src') + path.sep;
const CONFIG_MODULE_PATH = require.resolve('../config');

/**
 * Evict every already-cached module under src/ plus config.js from Node's
 * require cache. See this file's header comment for why: the next
 * loadApp() call must re-execute app.js and its whole dependency tree
 * (routes, services, db.js) from scratch against a fresh DATA_DIR/DB_PATH,
 * not return route/service modules still bound to the FIRST boot's db
 * connection.
 */
function evictAppModules() {
  for (const key of Object.keys(require.cache)) {
    if (key === CONFIG_MODULE_PATH || key.startsWith(SRC_ROOT_PREFIX)) {
      delete require.cache[key];
    }
  }
}

/** Seed `total` submissions, each on its own task (submissions carries UNIQUE(guest_id, task_id)). */
function seedSubmissions(db, guestId, total, labelPrefix) {
  const insertTask = db.prepare(`INSERT INTO tasks (title) VALUES (?)`);
  const insertSubmission = db.prepare(
    `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
     VALUES (?, ?, ?, ?, 0)`
  );
  for (let i = 0; i < total; i++) {
    const taskId = insertTask.run(`${labelPrefix} Task ${i}`).lastInsertRowid;
    insertSubmission.run(guestId, taskId, `${labelPrefix}-${i}.jpg`, `${labelPrefix}-${i}-t.jpg`);
  }
}

describe('GET /feed: a window with a newer AND an older page includes the script, both pagers, all four sentinels', () => {
  let agent;

  beforeAll(async () => {
    // First app boot in this file — plain loadApp(), no eviction needed.
    const loaded = loadApp();
    const db = loaded.db;
    const feed = require('../src/services/feed');

    const token = 'feedscrollmultiwindowtoken000000';
    const guestId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run(token, 'Feed Scroll Multi Window Guest').lastInsertRowid;
    agent = request.agent(loaded.app);
    signInGuest(loaded.app, token, agent);

    // Three windows: enough that the MIDDLE window has both a newer page
    // (the newest window above it) and an older page (the remainder below).
    seedSubmissions(db, guestId, 2 * feed.FEED_PAGE_SIZE + 5, 'feed-scroll-multi');
  });

  it('the newest window (no anchor) includes only the older half — no newer pager/sentinel yet', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/js/feed-scroll.js');
    expect(res.text).toContain('class="page-link page-link-older"');
    expect(res.text).toContain('id="feedSentinelOlder"');
    expect(res.text).toContain('id="feedEdgeOlder"');
    expect(res.text).not.toContain('class="page-link page-link-newer"');
    expect(res.text).not.toContain('id="feedSentinelNewer"');
  });

  it('the middle window includes the script, both pager links, and all four sentinel/indicator elements', async () => {
    const feed = require('../src/services/feed');
    const firstWindow = feed.feedWindow(null);
    expect(firstWindow.olderFromId).not.toBeNull();

    const res = await agent.get('/feed?from=' + firstWindow.olderFromId);
    expect(res.status).toBe(200);
    expect(res.text).toContain('/js/feed-scroll.js');
    expect(res.text).toContain('class="page-link page-link-newer"');
    expect(res.text).toContain('class="page-link page-link-older"');
    expect(res.text).toContain('id="feedSentinelNewer"');
    expect(res.text).toContain('id="feedEdgeNewer"');
    expect(res.text).toContain('id="feedSentinelOlder"');
    expect(res.text).toContain('id="feedEdgeOlder"');
    // FIX 6 (assistive tech): each indicator is an announced status region
    // with its own visually-hidden loading text, not a bare aria-hidden ring.
    expect(res.text).toContain('id="feedEdgeNewer" hidden role="status"');
    expect(res.text).toContain('id="feedEdgeOlder" hidden role="status"');
    expect(res.text).toContain('Loading newer photos');
    expect(res.text).toContain('Loading older photos');
  });
});

describe('GET /feed: a single-window feed (fewer than a page of photos) includes none of the auto-load additions', () => {
  let agent;

  beforeAll(async () => {
    // Second app boot in this file — must evict the first boot's cached
    // src/ tree first (see evictAppModules's doc comment) so this app and
    // its db.js are genuinely independent of the multi-window suite above.
    evictAppModules();
    const loaded = loadApp();
    const db = loaded.db;

    const token = 'feedscrollsinglewindowtoken00000';
    const guestId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run(token, 'Feed Scroll Single Window Guest').lastInsertRowid;
    agent = request.agent(loaded.app);
    signInGuest(loaded.app, token, agent);

    seedSubmissions(db, guestId, 3, 'feed-scroll-single');
  });

  it('includes neither the script, the pager nav, nor any sentinel/indicator element', async () => {
    const res = await agent.get('/feed');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('/js/feed-scroll.js');
    expect(res.text).not.toContain('class="pagination"');
    expect(res.text).not.toContain('feedSentinelNewer');
    expect(res.text).not.toContain('feedEdgeNewer');
    expect(res.text).not.toContain('feedSentinelOlder');
    expect(res.text).not.toContain('feedEdgeOlder');
  });
});
