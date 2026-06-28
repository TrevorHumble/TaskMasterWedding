// src/public/js/gallery.js
(function () {
  'use strict';

  // -----------------------------------------------------------------------
  // LIGHTBOX (click-to-enlarge)
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
      lightbox.classList.add('open');
      document.body.classList.add('lightbox-open');
      if (closeBtn) {
        closeBtn.focus();
      }
    }

    function closeLightbox() {
      lightbox.hidden = true;
      lightbox.classList.remove('open');
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
      if (lightbox.classList.contains('open') && (e.key === 'Escape' || e.key === 'Esc')) {
        closeLightbox();
      }
    });
  }

  // -----------------------------------------------------------------------
  // BOOTSTRAP
  // -----------------------------------------------------------------------
  function init() {
    initLightbox();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
