// src/public/js/slideshow.js — drives the end-of-night slideshow (issue #468).
//
// Progressive enhancement: the slides (task title cards + photos, grouped by
// task) are already in the DOM (rendered by src/views/slideshow.ejs). This
// script manages which slide is "on", the shared navigation (on-screen arrows,
// tap the left/right of the screen, arrow keys), a slow per-slide auto-advance
// in Auto mode, and the auto-hiding chrome. No framework, no dependency.
'use strict';

(function () {
  var root = document.getElementById('slideshow');
  if (!root) return;
  var stage = document.getElementById('stage');
  if (!stage) return; // empty state — nothing to drive

  var slides = Array.prototype.slice.call(stage.querySelectorAll('.slide'));
  if (slides.length === 0) return;

  var DEFAULT_DWELL = 12000; // fallback if a slide has no data-dwell
  var CHROME_IDLE = 2500; // hide the controls this long after the mouse stops
  var idx = 0;
  var paused = false;
  var mode = root.dataset.mode === 'directed' ? 'directed' : 'auto';
  var timer = null;
  var chromeTimer = null;

  var reduceMotion =
    window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function applyKenBurns() {
    slides.forEach(function (s) {
      var photo = s.querySelector('.photo');
      if (!photo) return;
      if (mode === 'auto' && !reduceMotion) photo.classList.add('kb');
      else photo.classList.remove('kb');
    });
  }

  function dwellFor(i) {
    var d = parseInt(slides[i].getAttribute('data-dwell'), 10);
    return d > 0 ? d : DEFAULT_DWELL;
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleAuto() {
    clearTimer();
    if (mode === 'auto' && !paused) timer = setTimeout(next, dwellFor(idx));
  }

  function show(i) {
    idx = (i + slides.length) % slides.length;
    slides.forEach(function (s, j) {
      s.classList.toggle('on', j === idx);
    });
    scheduleAuto();
  }

  function next() {
    show(idx + 1);
  }
  function prev() {
    show(idx - 1);
  }

  function setPaused(p) {
    paused = p;
    root.classList.toggle('is-paused', p);
    if (p) clearTimer();
    else scheduleAuto();
  }

  // ---- chrome: reveal on mouse movement only, then fade back out. Keyboard
  //      navigation never triggers it, so arrow keys never draw a focus line. ----
  function showChrome() {
    root.classList.add('show-chrome');
    if (chromeTimer) clearTimeout(chromeTimer);
    chromeTimer = setTimeout(hideChrome, CHROME_IDLE);
  }
  function hideChrome() {
    root.classList.remove('show-chrome');
  }

  root.addEventListener('mousemove', showChrome);
  root.addEventListener('mouseleave', hideChrome);
  root.addEventListener('touchstart', showChrome, { passive: true });

  // ---- navigation ----
  // Blur after a pointer click so the (non-tabbable) zone never keeps focus —
  // that stale focus is what lit up an outline when the user then hit an arrow.
  function navClick(fn) {
    return function (e) {
      fn();
      if (e.currentTarget && e.currentTarget.blur) e.currentTarget.blur();
    };
  }
  var navPrev = document.getElementById('navPrev');
  var navNext = document.getElementById('navNext');
  if (navPrev) navPrev.addEventListener('click', navClick(prev));
  if (navNext) navNext.addEventListener('click', navClick(next));

  document.addEventListener('keydown', function (e) {
    if (e.key === 'ArrowRight') {
      next();
    } else if (e.key === 'ArrowLeft') {
      prev();
    } else if (e.key === ' ') {
      e.preventDefault();
      if (mode === 'auto') setPaused(!paused);
    } else if (e.key === 'Escape') {
      var x = root.querySelector('.exit');
      if (x) x.click();
    }
  });

  // ---- start ----
  applyKenBurns();
  show(0);
})();
