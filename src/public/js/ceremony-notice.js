// src/public/js/ceremony-notice.js
//
// Issue #1042: dismiss behaviour for the ceremony-day notice band.
//
// Dismissal is held in sessionStorage, not localStorage: the band goes away
// for the rest of this browsing session and comes back the next time the guest
// opens the app. A ceremony-day warning that one tap kills permanently would
// stop warning the guest who most needs it.
//
// Loaded WITHOUT `defer` immediately after the band's markup (see
// partials/header.ejs), so it runs at that point in the parse, before the
// band is painted, so an already-dismissed band never flashes on screen.
(function () {
  'use strict';

  var KEY = 'ceremonyNoticeDismissed';
  var band = document.getElementById('ceremony-line');
  if (!band) {
    return;
  }

  // sessionStorage throws in a locked-down/private context in some browsers.
  // A failed read must leave the warning SHOWING, never swallow it.
  function dismissed() {
    try {
      return window.sessionStorage.getItem(KEY) === '1';
    } catch (_e) {
      return false;
    }
  }

  if (dismissed()) {
    band.remove();
    return;
  }

  band.addEventListener('click', function (ev) {
    if (!ev.target.closest('#ceremony-dismiss')) {
      return;
    }
    try {
      window.sessionStorage.setItem(KEY, '1');
    } catch (_e) {
      // Storage unavailable: still dismiss for this page load.
    }
    band.remove();
  });
})();
