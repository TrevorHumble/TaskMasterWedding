// src/public/js/lightbox.js
// Shared photo lightbox (issue #673) — progressive enhancement layered on top
// of the plain `<a href="/p/:id">` thumbnail links that the guest feed and the
// admin Photos page's inline feed already render. (Profiles are intentionally
// out of scope until they reach feed parity — issue #687.)
//
// With JS on, a tap on any `.js-lightbox` trigger opens the tapped photo at
// FULL resolution — built from data-lightbox-photo (the bare original
// filename, prefixed with /uploads/ here rather than in the markup; see
// render()) — in a single full-screen native <dialog>, instead of
// navigating to /p/:id. Prev/Next step through the sibling triggers in the
// same data-lightbox-group, in DOM order, so browsing never costs a page
// load. With JS off — or on a browser without <dialog>.showModal — the click
// is never intercepted and the anchor's href carries the guest to /p/:id
// exactly as before (the no-JS fallback).
//
// The overlay is built once, lazily, and reused. showModal() renders it in
// the top layer (escaping .feed-item's content-visibility containment, the
// same reason the #248 comments dialog is a <dialog>), makes the background
// inert, and closes on Escape natively; theme.css's `body:has(dialog[open])`
// rule freezes the page scroll while it is open, so the underlying page is
// exactly where it was when the overlay closes.
//
// Social row (guest surfaces only): a trigger that carries the optional
// data-lightbox-* social hooks renders a like/comment row inside the overlay;
// a trigger without them (the admin moderation variant) renders image +
// caption only. The row is presentational in this component — the like form
// and comments thread continue to live on the card behind the overlay.
'use strict';

(function () {
  if (typeof document === 'undefined') {
    return;
  }

  // Feature gate for the whole enhancement: a browser without native
  // <dialog>.showModal never has its clicks intercepted, so every trigger
  // falls through to its anchor href (the /p/:id fallback).
  var dialogSupported =
    typeof HTMLDialogElement === 'function' &&
    typeof HTMLDialogElement.prototype.showModal === 'function';

  var overlay = null; // the lazily-built <dialog>
  var els = null; // cached child refs once built
  var group = []; // current group's trigger elements, DOM order
  var index = -1; // active trigger's index within `group`
  var scrollYBeforeOpen = 0;

  // ------------------------------------------------------------------
  // Build the overlay once and cache its parts.
  // ------------------------------------------------------------------
  function build() {
    if (overlay) {
      return;
    }
    overlay = document.createElement('dialog');
    overlay.className = 'lightbox';
    overlay.setAttribute('aria-label', 'Photo viewer');

    var close = document.createElement('button');
    close.type = 'button';
    close.className = 'lightbox-close';
    close.setAttribute('data-lightbox-close', '');
    close.setAttribute('aria-label', 'Close');
    close.innerHTML = '&times;';

    var prev = document.createElement('button');
    prev.type = 'button';
    prev.className = 'lightbox-nav lightbox-prev';
    prev.setAttribute('data-lightbox-prev', '');
    prev.setAttribute('aria-label', 'Newer photo');
    prev.innerHTML = '&lsaquo;';

    var next = document.createElement('button');
    next.type = 'button';
    next.className = 'lightbox-nav lightbox-next';
    next.setAttribute('data-lightbox-next', '');
    next.setAttribute('aria-label', 'Older photo');
    next.innerHTML = '&rsaquo;';

    var figure = document.createElement('figure');
    figure.className = 'lightbox-figure';

    var img = document.createElement('img');
    img.className = 'lightbox-img';
    img.setAttribute('alt', '');

    var caption = document.createElement('figcaption');
    caption.className = 'lightbox-caption';

    var by = document.createElement('p');
    by.className = 'lightbox-by';

    var text = document.createElement('p');
    text.className = 'lightbox-text';

    var actions = document.createElement('div');
    actions.className = 'lightbox-actions';

    var like = document.createElement('span');
    like.className = 'lightbox-like';
    like.innerHTML =
      '<svg class="lightbox-heart" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 21s-8.5-5.3-8.5-11.2A4.8 4.8 0 0 1 12 6.6a4.8 4.8 0 0 1 8.5 3.2C20.5 15.7 12 21 12 21z"/>' +
      '</svg><span class="lightbox-like-count"></span>';

    var comment = document.createElement('span');
    comment.className = 'lightbox-comment';
    comment.innerHTML =
      '<svg class="lightbox-bubble" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 3C6.48 3 2 6.58 2 11c0 2.36 1.28 4.48 3.3 5.94-.11.9-.42 2.24-1.2 3.56a.5.5 0 0 0 .62.72c1.77-.64 3.13-1.5 3.99-2.13.99.24 2.05.37 3.29.37 5.52 0 10-3.58 10-8s-4.48-8-10-8z"/>' +
      '</svg><span class="lightbox-comment-count"></span>';

    actions.appendChild(like);
    actions.appendChild(comment);

    caption.appendChild(by);
    caption.appendChild(text);
    caption.appendChild(actions);

    figure.appendChild(img);
    figure.appendChild(caption);

    overlay.appendChild(close);
    overlay.appendChild(prev);
    overlay.appendChild(figure);
    overlay.appendChild(next);

    document.body.appendChild(overlay);

    els = {
      close: close,
      prev: prev,
      next: next,
      img: img,
      by: by,
      text: text,
      actions: actions,
      likeCount: like.querySelector('.lightbox-like-count'),
      commentCount: comment.querySelector('.lightbox-comment-count'),
      like: like,
      comment: comment,
    };
  }

  // ------------------------------------------------------------------
  // Render the overlay to the trigger at `group[index]`.
  // ------------------------------------------------------------------
  function render() {
    var trigger = group[index];
    if (!trigger) {
      return;
    }
    // The trigger carries only the bare original filename (data-lightbox-photo),
    // NOT a ready-made /uploads/ URL — the feed must not emit a full-resolution
    // path into its HTML (issue #194: a fetchable /uploads/ URL in the markup
    // could be speculatively prefetched, defeating the thumbnails-only feed).
    // The overlay builds the full-res URL here, on open, only when a photo is
    // actually viewed.
    var photo = trigger.getAttribute('data-lightbox-photo');
    els.img.setAttribute('src', photo ? '/uploads/' + photo : '');
    els.img.setAttribute('alt', trigger.getAttribute('data-lightbox-alt') || '');

    var by = trigger.getAttribute('data-lightbox-by');
    els.by.textContent = by || '';
    els.by.style.display = by ? '' : 'none';

    var text = trigger.getAttribute('data-lightbox-caption');
    els.text.textContent = text || '';
    els.text.style.display = text ? '' : 'none';

    // Social row shows only when the trigger supplies the like hook (guest
    // surfaces). The admin moderation trigger omits it, so the row is hidden.
    var likeCount = trigger.getAttribute('data-lightbox-like-count');
    if (likeCount === null) {
      els.actions.style.display = 'none';
    } else {
      els.actions.style.display = '';
      els.likeCount.textContent = likeCount;
      els.like.classList.toggle('is-liked', trigger.getAttribute('data-lightbox-liked') === 'true');
      els.commentCount.textContent = trigger.getAttribute('data-lightbox-comment-count') || '0';
    }

    // Disable each arrow at the group edge (no wrap-around) — matches the
    // feed/admin grids being a bounded, already-loaded window.
    els.prev.disabled = index <= 0;
    els.next.disabled = index >= group.length - 1;
  }

  // ------------------------------------------------------------------
  // Open / navigate / close.
  // ------------------------------------------------------------------
  function openFrom(trigger) {
    build();
    var groupName = trigger.getAttribute('data-lightbox-group') || '';
    var selector = groupName
      ? '.js-lightbox[data-lightbox-group="' + cssEscape(groupName) + '"]'
      : '.js-lightbox';
    group = Array.prototype.slice.call(document.querySelectorAll(selector));
    index = group.indexOf(trigger);
    if (index === -1) {
      group = [trigger];
      index = 0;
    }
    scrollYBeforeOpen = window.scrollY || window.pageYOffset || 0;
    render();
    if (!overlay.open) {
      overlay.showModal();
    }
  }

  function step(delta) {
    var target = index + delta;
    if (target < 0 || target >= group.length) {
      return;
    }
    index = target;
    render();
  }

  function closeOverlay() {
    if (overlay && overlay.open) {
      overlay.close();
    }
  }

  // A minimal CSS.escape shim for the group attribute value (older engines
  // lack CSS.escape). The group names this app emits are simple slugs, but
  // escaping keeps the attribute selector well-formed regardless.
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === 'function') {
      return window.CSS.escape(value);
    }
    return String(value).replace(/["\\]/g, '\\$&');
  }

  // ------------------------------------------------------------------
  // Wiring.
  // ------------------------------------------------------------------
  document.addEventListener('click', function (event) {
    // Open: a tap on a lightbox trigger (only when dialogs are supported —
    // otherwise the anchor navigates to /p/:id, the no-JS fallback).
    var trigger = event.target.closest && event.target.closest('.js-lightbox');
    if (trigger && dialogSupported) {
      event.preventDefault();
      openFrom(trigger);
      return;
    }
    if (!overlay || !overlay.open) {
      return;
    }
    if (event.target.closest('[data-lightbox-prev]')) {
      step(-1);
      return;
    }
    if (event.target.closest('[data-lightbox-next]')) {
      step(1);
      return;
    }
    if (event.target.closest('[data-lightbox-close]')) {
      closeOverlay();
      return;
    }
    // Tap outside the photo closes. With a full-viewport <dialog> the true
    // ::backdrop is never reachable, so the dark margin around the image is
    // the <figure> itself — treat a tap on the dialog OR on the figure's own
    // empty area (never on the image, caption, or a control) as a close.
    if (event.target === overlay || event.target.classList.contains('lightbox-figure')) {
      closeOverlay();
    }
  });

  // Arrow-key navigation while the overlay is open.
  document.addEventListener('keydown', function (event) {
    if (!overlay || !overlay.open) {
      return;
    }
    if (event.key === 'ArrowLeft') {
      step(-1);
    } else if (event.key === 'ArrowRight') {
      step(1);
    }
  });

  // Restore the pre-open scroll position on close (browser Back closes the
  // top-layer dialog too, firing this same event). `body:has(dialog[open])`
  // froze the scroll while open; this guards against any focus-driven shift.
  document.addEventListener(
    'close',
    function (event) {
      if (event.target === overlay) {
        window.scrollTo(0, scrollYBeforeOpen);
      }
    },
    true
  );
})();
