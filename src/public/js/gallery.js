// src/public/js/gallery.js
(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // 1) LAZY-LOADING THUMBNAILS
  // -----------------------------------------------------------------------
  function loadImage(img) {
    var src = img.getAttribute('data-src');
    if (src) {
      img.src = src;
      img.removeAttribute('data-src');
    }
  }

  function initLazyLoad() {
    var lazyImages = document.querySelectorAll('img.js-lazy[data-src]');
    if (lazyImages.length === 0) {
      return;
    }

    // No IntersectionObserver support -> just load them all now.
    if (typeof window.IntersectionObserver !== 'function') {
      for (var i = 0; i < lazyImages.length; i++) {
        loadImage(lazyImages[i]);
      }
      return;
    }

    var observer = new IntersectionObserver(
      function (entries, obs) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            loadImage(entry.target);
            obs.unobserve(entry.target);
          }
        });
      },
      { rootMargin: '200px 0px', threshold: 0.01 }
    );

    lazyImages.forEach(function (img) {
      observer.observe(img);
    });
  }

  // -----------------------------------------------------------------------
  // 2) LIGHTBOX (click-to-enlarge)
  // -----------------------------------------------------------------------
  function initLightbox() {
    var lightbox = document.getElementById('lightbox');
    var lightboxImg = document.getElementById('lightboxImg');
    var lightboxCaption = document.getElementById('lightboxCaption');
    var closeBtn = document.getElementById('lightboxClose');

    // If this page has no lightbox markup, do nothing.
    if (!lightbox || !lightboxImg || !lightboxCaption) {
      return;
    }

    var lastFocused = null;

    function openLightbox(fullSrc, caption) {
      lastFocused = document.activeElement;
      lightboxImg.src = fullSrc;
      lightboxImg.alt = caption || '';
      lightboxCaption.textContent = caption || '';
      lightbox.hidden = false;
      document.body.classList.add('lightbox-open');
      if (closeBtn) {
        closeBtn.focus();
      }
    }

    function closeLightbox() {
      lightbox.hidden = true;
      lightboxImg.src = '';
      lightboxImg.alt = '';
      lightboxCaption.textContent = '';
      document.body.classList.remove('lightbox-open');
      if (lastFocused && typeof lastFocused.focus === 'function') {
        lastFocused.focus();
      }
    }

    // Open when any thumbnail button is activated.
    var buttons = document.querySelectorAll('.js-lightbox');
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var full = btn.getAttribute('data-full');
        var caption = btn.getAttribute('data-caption') || '';
        if (full) {
          openLightbox(full, caption);
        }
      });
    });

    // Close on the close button.
    if (closeBtn) {
      closeBtn.addEventListener('click', closeLightbox);
    }

    // Close when clicking the dark backdrop (but not the image/caption).
    lightbox.addEventListener('click', function (e) {
      if (e.target === lightbox) {
        closeLightbox();
      }
    });

    // Close on Escape.
    document.addEventListener('keydown', function (e) {
      if (!lightbox.hidden && (e.key === 'Escape' || e.key === 'Esc')) {
        closeLightbox();
      }
    });
  }

  // -----------------------------------------------------------------------
  // BOOTSTRAP
  // -----------------------------------------------------------------------
  function init() {
    initLazyLoad();
    initLightbox();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
