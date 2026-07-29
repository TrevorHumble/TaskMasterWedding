// tests/badge-moment-script.test.js
// Issue #902 PR review, minor finding 4: the continue-through queue's client
// behavior (src/public/js/badge-moment.js, plus its shared window.paintBadge
// from src/public/js/recap.js) had no jsdom test that could fail on its own —
// only server-rendered markup was ever asserted. Mirrors
// tests/badge-picker-script.test.js's jsdom-driven pattern (build a synthetic
// document matching what src/views/partials/header.ejs actually renders,
// install window/document/navigator as globals, stub <dialog> (jsdom does
// not implement showModal/close), require the real scripts fresh, drive them
// with dispatched events) plus tests/crowd-favorite-crown.test.js's AC5
// fetch-stubbing convention (stub window.fetch, drain the pending promise
// chain with a macrotask `await`).
//
// Covers:
//   - "Continue — N more" -> advance -> "Done" label sequence, each advance
//     posting the just-shown badge's stamp; Done closes.
//   - a single-badge celebration (no #badge-queue-data list at all): Continue
//     closes immediately, no stamp POST fired (AC4).
//   - the finding-1 regression: dismissing the dialog mid-queue (its native
//     'close' event, standing in for Escape/backdrop-dismiss — jsdom does
//     not implement either) must leave the queue abandoned, so that a LATER
//     replay's Continue plainly closes instead of resuming it and firing a
//     stamp for a badge the guest never actually saw shown.
//
// Script load order in the fixture matches header.ejs's real <script> tags
// (badge-moment.js, THEN recap.js) — the same order `defer` preserves on a
// real page — so this also proves window.paintBadge really is read lazily by
// badge-moment.js rather than captured at its own (earlier) load time.
'use strict';

const { JSDOM } = require('jsdom');

const BADGE_MOMENT_JS_PATH = require.resolve('../src/public/js/badge-moment.js');
const RECAP_JS_PATH = require.resolve('../src/public/js/recap.js');

// Mirrors src/views/partials/header.ejs's real #badge-dialog markup (the
// head badge's title/sub/art already server-rendered, exactly as
// resolveBadgeMoment/header.ejs would have left it) plus #badge-queue-data
// (one <li data-badge-*> per QUEUED badge, art pre-rendered the same way
// header.ejs's own `include('badge-art', ...)` call produces) and one
// recap-row badge button (header.ejs's recap-panel forEach shape) standing
// in for a LATER replay tap on a different, already-celebrated badge.
//
// `queueItems` — 0, 1, or 2 <li> entries — lets each test ask for exactly
// the queue shape it needs without a second markup function.
function pageMarkup(queueItems) {
  var queueListHtml = '';
  if (queueItems.length > 0) {
    var items = queueItems
      .map(function (item) {
        return (
          '<li data-badge-code="' +
          item.code +
          '" data-badge-name="' +
          item.name +
          '" data-badge-description="' +
          item.description +
          '" data-badge-art-html=\'<img class="badge-art" src="/badges/' +
          item.code.toLowerCase() +
          '.svg" alt="" />\'></li>'
        );
      })
      .join('');
    queueListHtml = '<ul id="badge-queue-data" hidden>' + items + '</ul>';
  }

  return (
    '<dialog class="badge-dialog" id="badge-dialog" tabindex="-1">' +
    '<div class="badge-card">' +
    '<p class="eyebrow badge-eyebrow">You earned a badge</p>' +
    '<h2 class="badge-title">Head Badge!</h2>' +
    '<div class="badge-stage"><span class="badge-sway">' +
    '<img class="badge-art" src="/badges/head.svg" alt="" /></span></div>' +
    '<p class="badge-sub">Head description.</p>' +
    '<button type="button" class="btn badge-continue">Continue</button>' +
    '</div>' +
    '</dialog>' +
    queueListHtml +
    '<ul id="recap-list">' +
    '<li class="recap-row recap-row-badge">' +
    '<button type="button" class="recap-row-link" data-badge-code="REPLAY" ' +
    'data-badge-name="Replay Badge" data-badge-description="Replay description" ' +
    'data-badge-art-html=\'<img class="badge-art" src="/badges/replay.svg" alt="" />\'>' +
    '</button></li></ul>'
  );
}

/**
 * Build a fresh jsdom document, install window/document/navigator/fetch as
 * globals, stub <dialog>.showModal/close (jsdom implements neither — close()
 * here also dispatches a real 'close' event, matching a real browser's
 * native dialog, since badge-moment.js's finding-1 fix depends on that event
 * firing), then require recap.js followed by the real badge-moment.js fresh
 * (header.ejs's own script-tag order), so both scripts' listeners bind to
 * THIS document.
 *
 * @param {Array<{code:string,name:string,description:string}>} queueItems
 * @returns {{doc: Document, fetchCalls: Array<object>, restore: Function}}
 */
function loadBadgeMoment(queueItems) {
  const dom = new JSDOM('<!doctype html><html><body>' + pageMarkup(queueItems) + '</body></html>', {
    url: 'http://localhost/',
  });

  const dialogEl = dom.window.document.getElementById('badge-dialog');
  dialogEl.open = false;
  dialogEl.showModal = function () {
    this.open = true;
  };
  dialogEl.close = function () {
    this.open = false;
    // Real <dialog>.close() fires a 'close' event synchronously — jsdom does
    // not implement this, so it is reproduced here. badge-moment.js's own
    // 'close' listener (issue #902 PR review, major finding 1) depends on
    // this firing for BOTH the capture-listener's own dialog.close() call
    // AND a native dismiss (Escape/backdrop), which this test simulates by
    // calling dialogEl.close() directly.
    this.dispatchEvent(new dom.window.Event('close'));
  };

  const fetchCalls = [];
  dom.window.fetch = function (url, opts) {
    fetchCalls.push({ url: url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    return Promise.resolve({ ok: true, status: 204 });
  };

  const keys = ['window', 'document', 'navigator', 'fetch'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value: value, configurable: true, writable: true });
  });

  // header.ejs's real order: badge-moment.js's <script> tag is written
  // BEFORE recap.js's — requiring them in that same order here is what
  // actually proves window.paintBadge is read lazily (at click time), not
  // captured at badge-moment.js's own (earlier) load time.
  delete require.cache[BADGE_MOMENT_JS_PATH];
  require(BADGE_MOMENT_JS_PATH);
  delete require.cache[RECAP_JS_PATH];
  require(RECAP_JS_PATH);

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { doc: dom.window.document, dialogEl: dialogEl, fetchCalls: fetchCalls, restore: restore };
}

function click(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

// Let a stubbed fetch's .catch()/.then() chain drain — a macrotask boundary
// guarantees every pending microtask has already fired by the time it
// resolves (same idiom tests/crowd-favorite-crown.test.js's AC5 test uses).
function flushMicrotasks() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('badge-moment.js: "Continue — N more" -> advance -> "Done" -> close', () => {
  it('advances through a 2-badge queue, posting each stamp as it is shown, then closes on Done', async () => {
    const { doc, dialogEl, fetchCalls, restore } = loadBadgeMoment([
      { code: 'BOUQUET', name: 'Bouquet Builder', description: 'Completed 10 tasks.' },
      { code: 'BLOOM', name: 'First Bloom', description: 'Completed 5 tasks.' },
    ]);

    try {
      const dialog = doc.getElementById('badge-dialog');
      const title = dialog.querySelector('.badge-title');
      const sub = dialog.querySelector('.badge-sub');
      const continueButton = dialog.querySelector('.badge-continue');

      expect(dialogEl.open).toBe(true); // auto-opened on load
      expect(continueButton.textContent).toBe('Continue — 2 more');
      expect(fetchCalls.length).toBe(0); // the head badge is stamped server-side, no client POST

      click(doc, continueButton);
      expect(title.textContent).toBe('Bouquet Builder!');
      expect(sub.textContent).toBe('Completed 10 tasks.');
      expect(continueButton.textContent).toBe('Continue — 1 more');
      expect(fetchCalls.length).toBe(1);
      expect(fetchCalls[0].url).toBe('/badge-moment/celebrated');
      expect(fetchCalls[0].body).toEqual({ code: 'BOUQUET' });

      click(doc, continueButton);
      expect(title.textContent).toBe('First Bloom!');
      expect(continueButton.textContent).toBe('Done');
      expect(fetchCalls.length).toBe(2);
      expect(fetchCalls[1].body).toEqual({ code: 'BLOOM' });
      expect(dialogEl.open).toBe(true); // still open — Done has not been tapped yet

      click(doc, continueButton);
      expect(dialogEl.open).toBe(false); // Done closes
      expect(fetchCalls.length).toBe(2); // Done itself posts nothing
    } finally {
      restore();
    }
  });

  it('a single-badge celebration (no queue) reads "Continue" and closes on the first tap, with no stamp POST (AC4)', async () => {
    const { doc, dialogEl, fetchCalls, restore } = loadBadgeMoment([]);

    try {
      const dialog = doc.getElementById('badge-dialog');
      const continueButton = dialog.querySelector('.badge-continue');

      expect(continueButton.textContent).toBe('Continue'); // unchanged from the static server render

      click(doc, continueButton);
      expect(dialogEl.open).toBe(false);
      expect(fetchCalls.length).toBe(0);
    } finally {
      restore();
    }
  });
});

describe('badge-moment.js + recap.js: finding-1 regression — abandon mid-queue, then replay', () => {
  it('dismissing the dialog mid-queue, then replaying a different badge, closes on Continue instead of resuming the abandoned queue', async () => {
    const { doc, dialogEl, fetchCalls, restore } = loadBadgeMoment([
      { code: 'BOUQUET', name: 'Bouquet Builder', description: 'Completed 10 tasks.' },
      { code: 'BLOOM', name: 'First Bloom', description: 'Completed 5 tasks.' },
    ]);

    try {
      const dialog = doc.getElementById('badge-dialog');
      const title = dialog.querySelector('.badge-title');
      const continueButton = dialog.querySelector('.badge-continue');

      expect(dialogEl.open).toBe(true);
      expect(continueButton.textContent).toBe('Continue — 2 more');

      // The guest dismisses the dialog on the HEAD badge, without ever
      // tapping Continue — the exact "Escape mid-queue" shape all three
      // reviews traced (jsdom has no native Escape/backdrop dismiss, so the
      // dialog's own 'close' event, fired by loadBadgeMoment's close()
      // stub, stands in for it).
      dialogEl.close();
      expect(dialogEl.open).toBe(false);
      expect(fetchCalls.length).toBe(0); // nothing was ever shown via Continue

      // Later: the guest taps a DIFFERENT, already-celebrated badge's recap
      // row (replay) — this dispatches through the REAL recap.js delegated
      // click handler, which calls window.paintBadge and resets the
      // Continue label, exactly as it would on a real page.
      const replayButton = doc.querySelector('.recap-row-badge button.recap-row-link');
      click(doc, replayButton);
      expect(dialogEl.open).toBe(true);
      expect(title.textContent).toBe('Replay Badge!');
      expect(continueButton.textContent).toBe('Continue'); // reset, not "Continue — 1 more" / "Done"

      // Tapping Continue on the REPLAY must close the dialog — not resume
      // the abandoned BOUQUET/BLOOM queue (which would repaint the title
      // back to "Bouquet Builder!", post a stamp for it, and show a count).
      click(doc, continueButton);
      await flushMicrotasks();

      expect(dialogEl.open).toBe(false);
      expect(title.textContent).toBe('Replay Badge!'); // never overwritten by showQueued
      // No stamp was ever posted for the abandoned queue's badges.
      expect(fetchCalls.length).toBe(0);
    } finally {
      restore();
    }
  });
});
