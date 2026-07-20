// tests/lightbox.test.js
// Covers issue #673 (photo lightbox) acceptance criteria for the shared,
// standalone src/public/js/lightbox.js component. Mirrors the jsdom-driven
// pattern in tests/feed-card.test.js: require the real client script into a
// synthetic jsdom document and drive it with dispatched events.
//
//   AC2 — tapping a .js-lightbox trigger opens the overlay, sets the overlay
//         <img> src to the trigger's data-lightbox-photo (as /uploads/<name>), and calls
//         preventDefault (no navigation).
//   AC3 — Prev/Next step through triggers sharing the same
//         data-lightbox-group, in DOM order, disabled at the first/last item.
//   AC4 — closing via the close control and via Escape both run the
//         scroll-restore path (window.scrollTo with the pre-open scrollY) on
//         the dialog's native 'close' event.
//   AC5 — a trigger without the data-lightbox-like-count hook (admin/
//         moderation variant) renders no social row (.lightbox-actions
//         hidden); a trigger with it shows the like/comment counts.
//   AC6 — with HTMLDialogElement.prototype.showModal absent (no-JS /
//         unsupported fallback), a trigger click is not intercepted
//         (preventDefault is never called), so the anchor href would
//         navigate.
//
// jsdom note (same finding as tests/feed-card.test.js's AC5 amendment note):
// the installed jsdom (29.1.1) exposes HTMLDialogElement with only the
// `open` property — no showModal/close. lightbox.js reads
// `typeof HTMLDialogElement.prototype.showModal === 'function'` ONCE, at
// module load time, to decide whether the whole enhancement is active. So
// unlike feed-card.test.js (which stubs showModal/close after the dialog
// already exists in served markup), this suite must install the stub BEFORE
// requiring lightbox.js fresh — or, for AC6, deliberately leave it absent so
// the module loads into the "unsupported browser" branch. The close() stub
// additionally dispatches a real 'close' event (which a real dialog does
// synchronously on close()), because lightbox.js's scroll-restore logic is
// wired to that event, not to the close() call itself.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const LIGHTBOX_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'lightbox.js');

/**
 * Build a jsdom document from the given body markup, optionally stub
 * HTMLDialogElement's showModal/close (BEFORE the module is required, since
 * lightbox.js's feature gate is computed at load time), install
 * window/document/navigator as globals so the real lightbox.js binds its
 * listeners to this document, then require the real module fresh.
 *
 * @param {string} bodyHtml
 * @param {{stubDialog?: boolean}} [opts] stubDialog defaults to true (a
 *   dialog-supporting browser). Pass false to simulate an unsupported
 *   browser (AC6) — showModal is left undefined, matching jsdom's own
 *   default HTMLDialogElement.
 * @returns {{dom: JSDOM, doc: Document, showModalCalls: Element[],
 *   closeCalls: Element[], restore: () => void}}
 */
function loadLightbox(bodyHtml, opts) {
  const stubDialog = !opts || opts.stubDialog !== false;
  const dom = new JSDOM('<!doctype html><html><body>' + bodyHtml + '</body></html>', {
    url: 'http://localhost/feed',
  });

  const showModalCalls = [];
  const closeCalls = [];
  if (stubDialog) {
    dom.window.HTMLDialogElement.prototype.showModal = function () {
      showModalCalls.push(this);
      this.open = true;
    };
    dom.window.HTMLDialogElement.prototype.close = function () {
      if (!this.open) {
        return;
      }
      this.open = false;
      closeCalls.push(this);
      // Real <dialog>.close() fires a synchronous, non-bubbling 'close'
      // event — lightbox.js's scroll-restore listener depends on it.
      this.dispatchEvent(new dom.window.Event('close'));
    };
  }

  // lightbox.js references HTMLDialogElement as a bare global (its feature
  // gate), not via window.HTMLDialogElement — it must be installed too, or
  // `typeof HTMLDialogElement` resolves as 'undefined' regardless of what
  // was stubbed on dom.window.HTMLDialogElement.
  const keys = ['window', 'document', 'navigator', 'HTMLDialogElement'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    const value = key === 'window' ? dom.window : dom.window[key];
    Object.defineProperty(global, key, { value, configurable: true, writable: true });
  });

  delete require.cache[require.resolve(LIGHTBOX_JS_PATH)];
  require(LIGHTBOX_JS_PATH);

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { dom, doc: dom.window.document, showModalCalls, closeCalls, restore };
}

/** Dispatch a bubbling, cancelable click on `el` and return the event (so
 * `.defaultPrevented` can be asserted). */
function click(dom, el) {
  const evt = new dom.window.Event('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(evt);
  return evt;
}

// ---------------------------------------------------------------------------
// AC2 — opens in place at full res; preventDefault (no navigation).
// ---------------------------------------------------------------------------
describe('AC2: tapping a trigger opens the overlay at full resolution, no navigation', () => {
  it('sets the overlay <img> src from data-lightbox-photo and prevents the anchor navigation', () => {
    const { dom, doc, showModalCalls, restore } = loadLightbox(
      '<a id="t" href="/p/501" class="js-lightbox" data-lightbox-photo="full-501.jpg" ' +
        'data-lightbox-alt="A guest photo" data-lightbox-by="Guest A" ' +
        'data-lightbox-caption="Find the DJ">photo</a>'
    );
    try {
      const trigger = doc.getElementById('t');
      const evt = click(dom, trigger);

      expect(evt.defaultPrevented).toBe(true);
      expect(showModalCalls.length).toBe(1);

      const img = doc.querySelector('.lightbox-img');
      expect(img).not.toBeNull();
      expect(img.getAttribute('src')).toBe('/uploads/full-501.jpg');
      expect(img.getAttribute('alt')).toBe('A guest photo');

      // No navigation: the document location is unchanged.
      expect(dom.window.location.pathname).toBe('/feed');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC3 — Prev/Next walk the same data-lightbox-group in DOM order; disabled
// at the first/last item; a trigger in a different group is excluded.
// ---------------------------------------------------------------------------
describe('AC3: Prev/Next step through the group in DOM order, disabled at the ends', () => {
  it('steps forward and back within the group, skipping a trigger from a different group', () => {
    const { dom, doc, restore } = loadLightbox(
      '<a id="f1" class="js-lightbox" data-lightbox-group="feed" ' +
        'data-lightbox-photo="full-1.jpg">1</a>' +
        '<a id="x1" class="js-lightbox" data-lightbox-group="other" ' +
        'data-lightbox-photo="full-x.jpg">x</a>' +
        '<a id="f2" class="js-lightbox" data-lightbox-group="feed" ' +
        'data-lightbox-photo="full-2.jpg">2</a>' +
        '<a id="f3" class="js-lightbox" data-lightbox-group="feed" ' +
        'data-lightbox-photo="full-3.jpg">3</a>'
    );
    try {
      click(dom, doc.getElementById('f1'));

      const img = doc.querySelector('.lightbox-img');
      const prev = doc.querySelector('[data-lightbox-prev]');
      const next = doc.querySelector('[data-lightbox-next]');

      // Opened at the first item in its group: Prev disabled, Next enabled.
      expect(img.getAttribute('src')).toBe('/uploads/full-1.jpg');
      expect(prev.disabled).toBe(true);
      expect(next.disabled).toBe(false);

      // Next -> middle item (the "other"-group trigger is skipped entirely).
      click(dom, next);
      expect(img.getAttribute('src')).toBe('/uploads/full-2.jpg');
      expect(prev.disabled).toBe(false);
      expect(next.disabled).toBe(false);

      // Next -> last item: Next now disabled.
      click(dom, next);
      expect(img.getAttribute('src')).toBe('/uploads/full-3.jpg');
      expect(prev.disabled).toBe(false);
      expect(next.disabled).toBe(true);

      // Next again is a no-op at the last item.
      click(dom, next);
      expect(img.getAttribute('src')).toBe('/uploads/full-3.jpg');

      // Prev -> back to the middle, then back to the first (Prev disabled).
      click(dom, prev);
      expect(img.getAttribute('src')).toBe('/uploads/full-2.jpg');
      click(dom, prev);
      expect(img.getAttribute('src')).toBe('/uploads/full-1.jpg');
      expect(prev.disabled).toBe(true);

      // Prev again is a no-op at the first item.
      click(dom, prev);
      expect(img.getAttribute('src')).toBe('/uploads/full-1.jpg');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC4 — closing via the close control, and via Escape (the browser's native
// dialog behavior), both restore the pre-open scroll position.
// ---------------------------------------------------------------------------
describe('AC4: closing restores the pre-open scroll position', () => {
  it('the close control triggers window.scrollTo(0, scrollYBeforeOpen) on the dialog close event', () => {
    const { dom, doc, showModalCalls, closeCalls, restore } = loadLightbox(
      '<a id="t" class="js-lightbox" data-lightbox-photo="full-1.jpg">1</a>'
    );
    try {
      dom.window.scrollY = 240;
      const scrollToCalls = [];
      dom.window.scrollTo = function (x, y) {
        scrollToCalls.push([x, y]);
      };

      click(dom, doc.getElementById('t'));
      expect(showModalCalls.length).toBe(1);

      const closeButton = doc.querySelector('[data-lightbox-close]');
      click(dom, closeButton);

      expect(closeCalls.length).toBe(1);
      expect(scrollToCalls).toEqual([[0, 240]]);
    } finally {
      restore();
    }
  });

  it('Escape (the browser natively closing the modal <dialog>) also restores the scroll position', () => {
    const { dom, doc, showModalCalls, restore } = loadLightbox(
      '<a id="t" class="js-lightbox" data-lightbox-photo="full-1.jpg">1</a>'
    );
    try {
      dom.window.scrollY = 77;
      const scrollToCalls = [];
      dom.window.scrollTo = function (x, y) {
        scrollToCalls.push([x, y]);
      };

      click(dom, doc.getElementById('t'));
      expect(showModalCalls.length).toBe(1);

      // lightbox.js has no Escape keydown handler of its own — a real
      // <dialog> intercepts Escape natively and calls close() itself before
      // any app JS runs, firing the same 'close' event. Simulate that native
      // behavior directly on the dialog (rather than the close button) to
      // prove the scroll-restore listener is wired to the event, not to a
      // specific trigger path.
      const overlay = doc.querySelector('dialog.lightbox');
      overlay.close();

      expect(overlay.open).toBe(false);
      expect(scrollToCalls).toEqual([[0, 77]]);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 — a trigger without data-lightbox-like-count (admin/moderation
// variant) renders no social row; a trigger with it shows the counts.
// ---------------------------------------------------------------------------
describe('AC5: the social row is present only when the trigger supplies the like-count hook', () => {
  it('renders no .lightbox-actions row for a trigger missing data-lightbox-like-count', () => {
    const { dom, doc, restore } = loadLightbox(
      '<a id="admin" class="js-lightbox" data-lightbox-photo="full-admin.jpg">admin</a>'
    );
    try {
      click(dom, doc.getElementById('admin'));
      const actions = doc.querySelector('.lightbox-actions');
      expect(actions.style.display).toBe('none');
    } finally {
      restore();
    }
  });

  it('shows the like/comment counts for a trigger carrying the social hooks', () => {
    const { dom, doc, restore } = loadLightbox(
      '<a id="guest" class="js-lightbox" data-lightbox-photo="full-guest.jpg" ' +
        'data-lightbox-like-count="3" data-lightbox-liked="true" ' +
        'data-lightbox-comment-count="2">guest</a>'
    );
    try {
      click(dom, doc.getElementById('guest'));
      const actions = doc.querySelector('.lightbox-actions');
      expect(actions.style.display).toBe('');
      expect(doc.querySelector('.lightbox-like-count').textContent).toBe('3');
      expect(doc.querySelector('.lightbox-comment-count').textContent).toBe('2');
      expect(doc.querySelector('.lightbox-like').classList.contains('is-liked')).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
// AC6 — no-JS / unsupported fallback: with showModal absent, the click is
// never intercepted.
// ---------------------------------------------------------------------------
describe('AC6: without HTMLDialogElement.prototype.showModal, clicks fall through to the href', () => {
  it('does not call preventDefault and never builds the overlay', () => {
    const { dom, doc, showModalCalls, restore } = loadLightbox(
      '<a id="t" href="/p/501" class="js-lightbox" data-lightbox-photo="full-501.jpg">photo</a>',
      { stubDialog: false }
    );
    try {
      const evt = click(dom, doc.getElementById('t'));

      expect(evt.defaultPrevented).toBe(false);
      expect(showModalCalls.length).toBe(0);
      expect(doc.querySelector('dialog.lightbox')).toBeNull();
    } finally {
      restore();
    }
  });
});
