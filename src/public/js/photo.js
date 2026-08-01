// src/public/js/photo.js
// Client-side navigation for the photo detail page.
// Follows the server-rendered prev/next hrefs — no data fetching.
// Arrow keys and touch swipe both navigate to the same hrefs,
// so the page degrades cleanly without JS.
(function () {
  'use strict';

  function navigate(href) {
    if (href) {
      window.location.href = href;
    }
  }

  function init() {
    // Read the hrefs from the server-rendered anchors so the client
    // never has to recompute the order independently.
    var prevEl = document.querySelector('.js-photo-prev');
    var nextEl = document.querySelector('.js-photo-next');
    var prevHref = prevEl ? prevEl.getAttribute('href') : null;
    var nextHref = nextEl ? nextEl.getAttribute('href') : null;

    // ArrowLeft → newer (prev); ArrowRight → older (next).
    document.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') {
        navigate(prevHref);
      } else if (e.key === 'ArrowRight') {
        navigate(nextHref);
      }
    });

    // Touch swipe: swipe right → prev (newer), swipe left → next (older).
    // Only a deliberate one-finger horizontal swipe navigates. A pinch, a
    // vertical scroll, or a pan across an already-zoomed photo must not fling
    // the guest onto a different photo.
    var SWIPE_MIN_PX = 40;
    var armed = false;
    var startX = 0;
    var startY = 0;

    function disarm() {
      armed = false;
    }

    // A second finger disarms the gesture outright rather than being ignored:
    // touchend fires once per finger lifted, so a pinch that merely skipped
    // the multi-touch frame would still navigate on the release.
    document.addEventListener(
      'touchstart',
      function (e) {
        if (e.touches.length !== 1) {
          disarm();
          return;
        }
        armed = true;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
      },
      { passive: true }
    );

    document.addEventListener('touchcancel', disarm, { passive: true });

    document.addEventListener(
      'touchend',
      function (e) {
        if (!armed) return;
        disarm();
        // While the page is pinch-zoomed, a drag is panning the photo.
        var vv = window.visualViewport;
        if (vv && vv.scale > 1) return;
        var touch = e.changedTouches[0];
        var dx = touch.clientX - startX;
        var dy = touch.clientY - startY;
        // Require a minimum distance, and a clearly horizontal intent, so an
        // ordinary vertical scroll with some sideways drift does not count.
        if (Math.abs(dx) < SWIPE_MIN_PX) return;
        if (Math.abs(dx) <= Math.abs(dy)) return;
        if (dx > 0) {
          navigate(prevHref);
        } else {
          navigate(nextHref);
        }
      },
      { passive: true }
    );
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
