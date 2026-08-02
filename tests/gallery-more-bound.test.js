// tests/gallery-more-bound.test.js
// Covers issue #1056 — bounding how many pages "Show more" will accumulate
// into the live grid before it hands off to a real navigation.
//
// jsdom evidence only (per the issue's implementation plan step 3): jsdom
// performs no navigation, so the threshold activation's evidence here is
// event.defaultPrevented === false, no tiles appended on that click, and the
// href still pointing at the next page. What the newly loaded page renders
// (its own tiles alone) is existing server behavior already covered by
// tests/profile-photo-paging.test.js (#1004's AC2) — not re-proven here.
//
// Harness shape follows tests/gallery-show-more.test.js's jsdom section:
// gallery-more.js is required once at the top in plain Node (no `window`
// global yet, so its top-level `typeof window !== 'undefined'` guard is a
// no-op at require time); each test installs a fresh jsdom's globals and
// calls the exported wireUpShowMore() explicitly.
'use strict';

const { JSDOM } = require('jsdom');
const {
  appendNextPage,
  wireUpShowMore,
  MAX_PAGES_IN_GRID,
} = require('../src/public/js/gallery-more');
const { loadApp } = require('./helpers/testApp');

// REQUIRE ORDER: loadApp() must run before any require that pulls in config
// or db (see tests/helpers/testApp.js) — feed.js requires db.js. The app
// itself is not needed by this file; only GALLERY_PAGE_SIZE is, so the seed
// stays correct if the page size ever changes instead of hard-coding 60.
loadApp();
const { GALLERY_PAGE_SIZE } = require('../src/services/feed');

function tileMarkup(n) {
  return `<figure class="gallery-item" data-tile="${n}"><img src="/thumbs/${n}.jpg"></figure>`;
}

function tiles(count, offset) {
  return Array.from({ length: count }, (_, i) => offset + i);
}

/** A parsed "next page" document: a #galleryGrid plus an optional Show more control. */
function pageDocument({ tileCount, offset, nextHref }) {
  const nav = nextHref ? `<nav class="show-more"><a href="${nextHref}">Show more</a></nav>` : '';
  const html = `<div class="gallery-grid" id="galleryGrid">${tiles(tileCount, offset)
    .map(tileMarkup)
    .join('')}</div>${nav}`;
  return new JSDOM(html).window.document;
}

// Point window/document/navigator/fetch/DOMParser at a fresh jsdom instance,
// same technique as tests/gallery-show-more.test.js's installDomGlobals.
function installDomGlobals(dom, fetchStub) {
  const descriptorKeys = ['window', 'document', 'navigator'];
  const saved = {};
  descriptorKeys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  });
  const savedDOMParser = global.DOMParser;
  const savedFetch = global.fetch;
  global.DOMParser = dom.window.DOMParser;
  global.fetch = fetchStub;

  return function restore() {
    descriptorKeys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
    global.DOMParser = savedDOMParser;
    global.fetch = savedFetch;
  };
}

/** A fetch stub that resolves immediately with the given HTML on every call. */
function fetchStubFor(htmlByHref) {
  return function (url) {
    const html = htmlByHref(url);
    return Promise.resolve({ ok: true, text: () => Promise.resolve(html) });
  };
}

/** Let every already-queued microtask (and one macrotask turn) run. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildLiveDom(pageTileCount, nextHref) {
  return new JSDOM(
    `<div class="gallery-grid" id="galleryGrid">${tiles(pageTileCount, 0)
      .map(tileMarkup)
      .join('')}</div>
     <nav class="show-more"><a href="${nextHref}">Show more</a></nav>`,
    { url: 'http://localhost/gallery?view=recent&page=1' }
  );
}

/** A next-page document for page N of an otherwise endless wall. */
function endlessPage(page) {
  return pageDocument({
    tileCount: GALLERY_PAGE_SIZE,
    offset: page * GALLERY_PAGE_SIZE,
    nextHref: `/gallery?view=recent&page=${page + 1}`,
  });
}

function endlessFetchStub() {
  return fetchStubFor((url) => {
    const match = /page=(\d+)/.exec(url);
    const page = match ? Number(match[1]) : 2;
    return endlessPage(page).documentElement.outerHTML;
  });
}

async function click(doc) {
  const link = doc.querySelector('.show-more a');
  const event = new doc.defaultView.Event('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  await flushMicrotasks();
  return event;
}

describe('wireUpShowMore: bounds how many pages accumulate before handing off (#1056)', () => {
  it('AC1: appends through the threshold — 4 activations append, the grid holds 5 pages worth, no navigation', async () => {
    const dom = buildLiveDom(GALLERY_PAGE_SIZE, '/gallery?view=recent&page=2');
    const fetchStub = endlessFetchStub();
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const doc = dom.window.document;

      // Derived from the constant, not re-typed: if the threshold moves, this
      // test keeps exercising the threshold instead of silently testing a
      // click count that no longer reaches it.
      for (let i = 0; i < MAX_PAGES_IN_GRID - 1; i++) {
        const event = await click(doc);
        expect(event.defaultPrevented).toBe(true);
      }

      expect(doc.querySelectorAll('.gallery-item').length).toBe(
        GALLERY_PAGE_SIZE * MAX_PAGES_IN_GRID
      );
      expect(doc.querySelector('.show-more')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('AC2 (jsdom half): the 5th activation does not intercept — no preventDefault, no append, href still points at the next page', async () => {
    const dom = buildLiveDom(GALLERY_PAGE_SIZE, '/gallery?view=recent&page=2');
    const fetchStub = endlessFetchStub();
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const doc = dom.window.document;

      for (let i = 0; i < MAX_PAGES_IN_GRID - 1; i++) {
        await click(doc);
      }
      const countAtThreshold = doc.querySelectorAll('.gallery-item').length;
      const hrefAtThreshold = doc.querySelector('.show-more a').getAttribute('href');

      const eventAtThreshold = await click(doc);

      expect(eventAtThreshold.defaultPrevented).toBe(false);
      expect(doc.querySelectorAll('.gallery-item').length).toBe(countAtThreshold);
      expect(doc.querySelector('.show-more a').getAttribute('href')).toBe(hrefAtThreshold);
      // The grid holds MAX_PAGES_IN_GRID pages, so the control points at the
      // page after them — the one a real browser would now navigate to.
      expect(hrefAtThreshold).toBe('/gallery?view=recent&page=' + (MAX_PAGES_IN_GRID + 1));
    } finally {
      restore();
    }
  });

  it('AC4: the budget is per-wiring — a fresh wireUpShowMore() on the newly loaded page appends again instead of navigating immediately', async () => {
    // Simulates the page landed on after the threshold: a brand-new document,
    // a brand-new call to wireUpShowMore(), so the counter starts over.
    const dom = buildLiveDom(GALLERY_PAGE_SIZE, '/gallery?view=recent&page=7');
    const fetchStub = endlessFetchStub();
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const doc = dom.window.document;

      const event = await click(doc);

      expect(event.defaultPrevented).toBe(true);
      expect(doc.querySelectorAll('.gallery-item').length).toBe(GALLERY_PAGE_SIZE * 2);
      expect(doc.querySelector('.show-more')).not.toBeNull();
    } finally {
      restore();
    }
  });

  it('AC5: a short wall (2 pages total) is untouched — one activation appends the final page and removes the control', async () => {
    const dom = buildLiveDom(GALLERY_PAGE_SIZE, '/gallery?view=recent&page=2');
    const fetchStub = fetchStubFor(
      () =>
        pageDocument({
          tileCount: 5,
          offset: GALLERY_PAGE_SIZE,
          nextHref: null,
        }).documentElement.outerHTML
    );
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const doc = dom.window.document;

      const event = await click(doc);

      expect(event.defaultPrevented).toBe(true);
      expect(doc.querySelector('.show-more')).toBeNull();
      expect(doc.querySelectorAll('.gallery-item').length).toBe(GALLERY_PAGE_SIZE + 5);
    } finally {
      restore();
    }
  });

  it('a double-tap during an in-flight fetch is still swallowed, not turned into a navigation', async () => {
    // The bound split one unconditional preventDefault() into two branch-local
    // calls. The in-flight branch's own preventDefault() has no other coverage
    // that would fail if it were dropped — and dropping it would navigate a
    // guest away mid-fetch, losing the wall they had accumulated.
    const dom = buildLiveDom(GALLERY_PAGE_SIZE, '/gallery?view=recent&page=2');
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const fetchStub = () =>
      held.then(() => ({
        ok: true,
        text: () => Promise.resolve(endlessPage(2).documentElement.outerHTML),
      }));
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const doc = dom.window.document;

      const first = await click(doc); // starts the fetch, which stays pending
      const second = await click(doc); // lands while the first is in flight

      expect(first.defaultPrevented).toBe(true);
      expect(second.defaultPrevented).toBe(true);
      expect(doc.querySelectorAll('.gallery-item').length).toBe(GALLERY_PAGE_SIZE);

      release();
      await flushMicrotasks();
      expect(doc.querySelectorAll('.gallery-item').length).toBe(GALLERY_PAGE_SIZE * 2);
    } finally {
      restore();
    }
  });

  it('exports the threshold constant tests assert against, rather than a re-typed literal', () => {
    expect(MAX_PAGES_IN_GRID).toBe(5);
  });

  it('appendNextPage itself is unaffected by the bound — it lifts tiles unconditionally regardless of count', () => {
    const grid = new JSDOM(
      `<div class="gallery-grid" id="galleryGrid"></div>`
    ).window.document.getElementById('galleryGrid');
    const nextDoc = endlessPage(9);

    const result = appendNextPage(nextDoc, grid);

    expect(result.appended).toBe(GALLERY_PAGE_SIZE);
  });
});
