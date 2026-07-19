// tests/gallery-show-more.test.js
// Covers issue #610 — infinite-scroll "Show more" for the gallery's Recent
// view. Phase 1 (owner-approved, frozen 2026-07-19): src/public/js/gallery-more.js
// and the script include in src/views/gallery.ejs. This file is phase 2 —
// tests only, per the issue's implementation plan steps 3-4.
//
//   appendNextPage(doc, grid) — unit, against jsdom documents built directly
//   (prior art: tests/gallery-person-filter.test.js requires a
//   src/public/js module directly and drives it with plain DOM stand-ins):
//     - tiles append into the live grid and the count grows
//     - nextHref advances to the following page's href
//     - nextHref is null when the fetched page has no Show more control
//       (the last page)
//     - throws when the fetched document has no #galleryGrid
//
//   wireUpShowMore() — wire-level, jsdom + a stubbed global fetch (prior
//   art: tests/admin-guests-ui.test.js and tests/feed-card.test.js install
//   window/document/navigator globals so a src/public/js module's bare
//   `document` references resolve to a real jsdom document):
//     - the control's label reads "Loading…" and is aria-disabled while a
//       fetch is in flight
//     - a second click while the first fetch is still in flight fires no
//       second fetch
//     - the control is removed once the fetched page has no next page
//
//   Server-rendered shape — supertest against the real /gallery route
//   (prior art: tests/feed-card.test.js, tests/gallery-views.test.js #251
//   AC6): page 1 with more than one page of photos includes
//   /js/gallery-more.js and a .show-more link to page=2; the last page
//   includes neither.
//
// JSDOM timing gotcha: right after `new JSDOM(...)`, document.readyState is
// still 'loading', so gallery-more.js's own top-level effect would defer
// wiring to DOMContentLoaded. The wire-level tests below sidestep that
// entirely rather than race it: gallery-more.js is required once at the top
// of this file, in plain Node with no `window` global installed yet, so its
// `typeof window !== 'undefined'` guard is a no-op at require time; each
// test then installs a fresh jsdom's globals and calls the exported
// wireUpShowMore() explicitly, so wiring never depends on readyState timing.
'use strict';

const { JSDOM } = require('jsdom');
const request = require('supertest');
const { appendNextPage, wireUpShowMore } = require('../src/public/js/gallery-more');
const { loadApp, signInGuest } = require('./helpers/testApp');

// ---------------------------------------------------------------------------
// appendNextPage(doc, grid) — pure DOM lift, no globals required: doc and
// grid are passed in directly, exactly as the real caller (wireUpShowMore)
// supplies them.
// ---------------------------------------------------------------------------

function tileMarkup(n) {
  return `<figure class="gallery-item" data-tile="${n}"><img src="/thumbs/${n}.jpg"></figure>`;
}

/** A parsed "next page" document: a #galleryGrid plus an optional Show more control. */
function pageDocument({ tiles, nextHref }) {
  const nav = nextHref ? `<nav class="show-more"><a href="${nextHref}">Show more</a></nav>` : '';
  const html = `<div class="gallery-grid" id="galleryGrid">${tiles
    .map(tileMarkup)
    .join('')}</div>${nav}`;
  return new JSDOM(html).window.document;
}

/** The live #galleryGrid element appendNextPage appends into. */
function liveGrid(tiles) {
  const doc = new JSDOM(
    `<div class="gallery-grid" id="galleryGrid">${tiles.map(tileMarkup).join('')}</div>`
  ).window.document;
  return doc.getElementById('galleryGrid');
}

describe('appendNextPage: lifts the fetched page into the live grid', () => {
  it('appends the fetched tiles after the existing ones and the count grows', () => {
    const grid = liveGrid([1, 2]);
    const nextDoc = pageDocument({ tiles: [3, 4, 5], nextHref: '/gallery?view=recent&page=3' });

    const result = appendNextPage(nextDoc, grid);

    expect(result.appended).toBe(3);
    expect(grid.querySelectorAll('.gallery-item').length).toBe(5);
    const order = [...grid.querySelectorAll('.gallery-item')].map((el) =>
      el.getAttribute('data-tile')
    );
    expect(order).toEqual(['1', '2', '3', '4', '5']);
  });

  it('nextHref advances to the following page found in the fetched document', () => {
    const grid = liveGrid([1]);
    const nextDoc = pageDocument({ tiles: [2], nextHref: '/gallery?view=recent&page=3' });

    const result = appendNextPage(nextDoc, grid);

    expect(result.nextHref).toBe('/gallery?view=recent&page=3');
  });

  it('nextHref is null when the fetched page has no Show more control (the last page)', () => {
    const grid = liveGrid([1]);
    const nextDoc = pageDocument({ tiles: [2], nextHref: null });

    const result = appendNextPage(nextDoc, grid);

    expect(result.nextHref).toBeNull();
  });

  it('throws when the fetched document has no #galleryGrid', () => {
    const grid = liveGrid([1]);
    const nextDoc = new JSDOM('<p>not a gallery page</p>').window.document;

    expect(() => appendNextPage(nextDoc, grid)).toThrow(/gallery grid/);
  });
});

// ---------------------------------------------------------------------------
// wireUpShowMore() — wire-level, real click events against a stubbed fetch.
// ---------------------------------------------------------------------------

// Point window/document/navigator/fetch/DOMParser at a fresh jsdom instance
// so gallery-more.js's bare `document`/`window`/`fetch`/`DOMParser`
// references resolve to it. window/document/navigator use
// Object.defineProperty because newer Node defines global.navigator as
// getter-only (same technique as tests/admin-guests-ui.test.js);
// fetch/DOMParser are plain assignments — nothing else defines them as
// globals in the node test environment.
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

/**
 * A fetch stub whose promise the test resolves by hand, so a test can
 * observe the "request in flight" state before deciding what the server
 * answered.
 */
function deferredFetch() {
  let resolve;
  const calls = [];
  const stub = function (url) {
    calls.push(url);
    return new Promise((res) => {
      resolve = res;
    });
  };
  stub.calls = calls;
  stub.resolveWith = (html) => resolve({ ok: true, text: () => Promise.resolve(html) });
  return stub;
}

/** Let every already-queued microtask (and one macrotask turn) run. */
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function buildLiveDom(nextHref) {
  return new JSDOM(
    `<div class="gallery-grid" id="galleryGrid">${tileMarkup(1)}</div>
     <nav class="show-more"><a href="${nextHref}">Show more</a></nav>`,
    { url: 'http://localhost/gallery?view=recent&page=1' }
  );
}

describe('wireUpShowMore: click path with a stubbed fetch', () => {
  it('the control reads "Loading…" and is aria-disabled while the fetch is in flight', () => {
    const dom = buildLiveDom('/gallery?view=recent&page=2');
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const link = dom.window.document.querySelector('.show-more a');
      link.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));

      expect(link.textContent).toBe('Loading…');
      expect(link.getAttribute('aria-disabled')).toBe('true');
    } finally {
      restore();
    }
  });

  it('a second click while the first fetch is still in flight fires no second fetch', () => {
    const dom = buildLiveDom('/gallery?view=recent&page=2');
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const link = dom.window.document.querySelector('.show-more a');
      link.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));
      link.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));

      expect(fetchStub.calls.length).toBe(1);
    } finally {
      restore();
    }
  });

  it('the control is removed once the fetched page has no next page', async () => {
    const dom = buildLiveDom('/gallery?view=recent&page=2');
    const fetchStub = deferredFetch();
    const restore = installDomGlobals(dom, fetchStub);
    try {
      wireUpShowMore();
      const doc = dom.window.document;
      const link = doc.querySelector('.show-more a');
      link.dispatchEvent(new dom.window.Event('click', { bubbles: true, cancelable: true }));

      // The fetched page's own grid has no Show more control — the last page.
      const lastPageHtml = `<div class="gallery-grid" id="galleryGrid">${tileMarkup(2)}</div>`;
      fetchStub.resolveWith(lastPageHtml);
      await flushMicrotasks();

      expect(doc.querySelector('.show-more')).toBeNull();
      // The tile from the last page still landed in the grid on the way out.
      expect(doc.querySelectorAll('.gallery-item').length).toBe(2);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Server-rendered shape — GET /gallery?view=recent via supertest against the
// real app and a real (temp, isolated) database. GALLERY_PAGE_SIZE comes
// from src/services/feed.js rather than a hard-coded literal, matching
// tests/gallery-views.test.js #251 AC6 — the seed stays correct if the page
// size ever changes.
// ---------------------------------------------------------------------------
describe('GET /gallery?view=recent: the Show more script and link only render when a next page exists', () => {
  let db;
  let agent;

  beforeAll(async () => {
    // REQUIRE ORDER: loadApp() must run before any require that pulls in
    // config or db (see tests/helpers/testApp.js) — feed.js requires db.js,
    // so it is required only after loadApp() has pointed DATA_DIR at a temp
    // dir.
    const loaded = loadApp();
    db = loaded.db;
    const feed = require('../src/services/feed');

    const token = 'showmoreservertoken0000000000000';
    const guestId = db
      .prepare(`INSERT INTO guests (token, name) VALUES (?, ?)`)
      .run(token, 'Show More Server Guest').lastInsertRowid;

    agent = request.agent(loaded.app);
    signInGuest(loaded.app, token, agent);

    // One page and change: page 1 is full (more to come), page 2 is the
    // final, partial page. submissions carries a UNIQUE(guest_id, task_id)
    // constraint (one submission per guest per task), so each photo needs
    // its own task — same shape as tests/gallery-views.test.js #251 AC6.
    const insertTask = db.prepare(`INSERT INTO tasks (title) VALUES (?)`);
    const insertSubmission = db.prepare(
      `INSERT INTO submissions (guest_id, task_id, photo_path, thumb_path, taken_down)
       VALUES (?, ?, ?, ?, 0)`
    );
    const total = feed.GALLERY_PAGE_SIZE + 5;
    for (let i = 0; i < total; i++) {
      const taskId = insertTask.run(`Show More Server Test Task ${i}`).lastInsertRowid;
      insertSubmission.run(guestId, taskId, `gallery-more-${i}.jpg`, `gallery-more-${i}-t.jpg`);
    }
  });

  it('page 1 (more pages remain) includes /js/gallery-more.js and a .show-more link to page=2', async () => {
    const res = await agent.get('/gallery?view=recent&page=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('/js/gallery-more.js');
    expect(res.text).toContain('href="/gallery?view=recent&page=2"');
  });

  it('the last page includes neither the script nor the .show-more link', async () => {
    const res = await agent.get('/gallery?view=recent&page=2');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('/js/gallery-more.js');
    expect(res.text).not.toContain('class="show-more"');
  });
});
