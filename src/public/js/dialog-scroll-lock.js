// src/public/js/dialog-scroll-lock.js
//
// Issue #922: the single owner of "is any <dialog> open anywhere on this
// page" — freezes the page scroll behind an open dialog by toggling one body
// class, replacing feed.css's old `body:has(dialog[open])` rule (deleted,
// #922), which fails closed on an engine without :has() support (iOS < 15.4,
// Chrome < 105): the page behind an open dialog would scroll right along
// with it there.
//
// A MutationObserver on the whole document, not a load-time query, because
// no dialog in the app is server-rendered `open` (every one opens via
// showModal()) and the lightbox's <dialog> is created lazily at runtime
// (document.createElement('dialog') in build(), src/public/js/lightbox.js),
// well after this script has already run. Watching document.documentElement
// with subtree:true for `open`-attribute changes catches a dialog created at
// any later time, not just the ones present at first paint.
//
// Loaded from src/views/partials/footer.ejs, included by every view that can
// render a dialog — the four footer-less views (404, error, maintenance,
// slideshow) include no header either and contain no <dialog>.
'use strict';

(function () {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') {
    return;
  }

  var LOCK_CLASS = 'dialog-scroll-lock';

  // Recomputed from the live count each time, not incremented/decremented —
  // the count is what decides the class, and re-deriving it from the DOM
  // directly is the same "one owner, no separate running tally to drift"
  // reasoning the rest of this file follows for the class itself.
  function sync() {
    var openCount = document.querySelectorAll('dialog[open]').length;
    document.body.classList.toggle(LOCK_CLASS, openCount > 0);
  }

  var observer = new MutationObserver(sync);
  // childList as well as attributes: an open <dialog> that is REMOVED from the
  // document rather than closed mutates no `open` attribute, so an
  // attributes-only observer would never re-run and the lock would strand,
  // freezing the page scroll for the rest of the session. The `:has()` rule
  // this replaces was live and released instantly. No code in src/public/js
  // removes a dialog today, so this guards a shape rather than a live bug.
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['open'],
  });

  sync();
})();
