// src/public/js/date-field.js
// Progressive enhancement for partials/date-field.ejs (issue #875).
//
// Two independent jobs, both purely additive — with scripts off the fields are
// still ordinary <input type="date"> controls and the server-side guard in
// src/routes/admin/config.js is still the one that decides what persists:
//
//   1. The calendar button. The EJS renders it `hidden`; this script unhides
//      it and points it at its own field. Once a field's own button is
//      confirmed working, its wrapper gets a `js-date` class (per field, not
//      document-wide -- a field whose .date-input lookup fails is left
//      alone) which the CSS gates the native indicator's collapse behind, so
//      there is never a moment with two glyphs and never a field with none;
//      Safari on macOS draws nothing at all, which is the case that makes an
//      affordance of our own worth having rather than styling the browser's.
//
//   2. The range wiring. Pins the end field's `min` to whatever the start
//      field currently holds, and blocks a submit whose range is inverted with
//      a message naming the problem — so the host fixes it in place instead of
//      losing the page to a redirect and reading the error on the way back.
'use strict';

var INVERTED_MSG = 'The wedding has to end on or after it starts.';

function enhanceButtons() {
  var buttons = document.querySelectorAll('.date-field .date-open');
  if (!buttons.length) return;

  Array.prototype.forEach.call(buttons, function (button) {
    var input = button.parentNode.querySelector('.date-input');
    if (!input) return;
    button.hidden = false;
    // Only now, once THIS field's own button is confirmed working, does the
    // stylesheet get permission to hide THIS field's native indicator --
    // scoped to the field's own wrapper, not the whole document, so a
    // sibling field whose lookup failed above is never left with its native
    // indicator collapsed and no button put back in its place.
    button.parentNode.classList.add('js-date');
    button.addEventListener('click', function () {
      // Focus first, unconditionally: on an engine without showPicker (or one
      // that refuses the call) the field is at least ready to type into, which
      // is the same place a click on the field itself would have left it.
      input.focus();
      if (typeof input.showPicker !== 'function') return;
      try {
        input.showPicker();
      } catch (_) {
        // Engines may throw when they judge the call not user-initiated
        // enough. The focus above already happened; nothing further to do.
      }
    });
  });
}

function wireRange() {
  var form = document.querySelector('[data-date-range]');
  if (!form) return;
  var start = form.querySelector('[data-range-start]');
  var end = form.querySelector('[data-range-end]');
  var error = form.querySelector('[data-range-error]');
  if (!start || !end || !error) return;

  // Returns true when the pair is submittable. Both-values-present is the only
  // case this can judge: an empty field is the server's to reject, not ours.
  function check() {
    if (start.value) end.min = start.value;
    var inverted = Boolean(start.value && end.value && start.value > end.value);
    // Unhide before writing the text on the inverted branch: a textContent
    // write to a still-`display: none` live region generally goes
    // unannounced, and unhiding alone is not a reliable trigger either -- the
    // order here is what makes the change likely to be announced.
    if (inverted) {
      error.hidden = false;
      error.textContent = INVERTED_MSG;
    } else {
      error.textContent = '';
      error.hidden = true;
    }
    return !inverted;
  }

  // The form carries `novalidate` (src/views/admin-config.ejs) so a stale
  // server-rendered `min` can never veto a submit the host is in the middle
  // of fixing -- but `novalidate` also switches off the browser's native
  // badInput block, which used to catch a half-typed date (e.g. "08/07/"
  // with the year left blank) before it ever reached the server. Restore
  // that in-place block ourselves: badInput is checked, and blocked, before
  // check() runs, so a half-typed date never reaches the range logic at all.
  // Every property access is guarded -- jsdom implements neither
  // `validity.badInput` nor `reportValidity()`, and older engines predating
  // the Constraint Validation API have no `validity` object at all.
  function badInputField() {
    if (start.validity && start.validity.badInput) return start;
    if (end.validity && end.validity.badInput) return end;
    return null;
  }

  start.addEventListener('change', check);
  end.addEventListener('change', check);
  form.addEventListener('submit', function (event) {
    var badField = badInputField();
    if (badField) {
      event.preventDefault();
      badField.focus();
      // An explicit reportValidity() call still reports under a form-level
      // `novalidate` -- novalidate only switches off the IMPLICIT check the
      // browser would otherwise run on submit.
      if (typeof badField.reportValidity === 'function') badField.reportValidity();
      return;
    }
    if (check()) return;
    event.preventDefault();
    end.focus();
  });

  // Run once on load so an already-inverted stored pair says so immediately
  // rather than waiting for the host to touch a field.
  check();
}

function init() {
  enhanceButtons();
  wireRange();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
