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
    var touchStartX = null;
    document.addEventListener(
      'touchstart',
      function (e) {
        touchStartX = e.changedTouches[0].clientX;
      },
      { passive: true }
    );

    document.addEventListener(
      'touchend',
      function (e) {
        if (touchStartX === null) return;
        var dx = e.changedTouches[0].clientX - touchStartX;
        touchStartX = null;
        // Require a minimum swipe distance to avoid accidental triggers.
        if (Math.abs(dx) < 40) return;
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
