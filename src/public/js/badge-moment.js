// src/public/js/badge-moment.js
// Issue #255: opens the badge-earned modal on load and wires its dismiss
// button. Mirrors the native <dialog> pattern from #248's comments dialog
// (src/public/js/feed.js) — showModal()/close(); Escape and a backdrop click
// dismiss natively, no code needed for either. No polling: the dialog is
// either present in the initial render (a badge was just earned) or absent.
//
// This script is included by src/views/task.ejs ONLY when a badgeMoment is
// present, so `.badge-dialog` always exists when this file runs — the
// existence guard below is belt-and-suspenders, matching the defensive style
// of the rest of this app's page scripts.
//
// The 'playing' class gates the bloom animation in theme.css (itself gated
// under prefers-reduced-motion: no-preference); adding it under reduced
// motion is harmless since no rule in that media block ever matches.
'use strict';

(function () {
  if (typeof document === 'undefined') {
    return;
  }

  var dialog = document.querySelector('.badge-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') {
    return;
  }

  dialog.showModal();
  // showModal() auto-focuses the first focusable descendant (the Continue
  // button), which paints a focus ring on it — reads as a stray border on
  // open. Move focus to the dialog itself (tabindex=-1) so the modal is still
  // focused for a11y/Escape, but no control shows a ring until the guest
  // actually tabs to it. Guard: focus() only if the browser put focus inside.
  if (typeof dialog.focus === 'function') {
    dialog.focus();
  }
  // Force a reflow before adding the class so the CSS animations always
  // start from their 0% frame — the same trick the owner-approved prototype
  // used for its replay control, kept here even though this modal only ever
  // plays once per page load.
  void dialog.offsetWidth;
  dialog.classList.add('playing');

  var doneButton = dialog.querySelector('.badge-done');
  if (doneButton) {
    doneButton.addEventListener('click', function () {
      dialog.close();
    });
  }
})();
