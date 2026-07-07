// src/public/js/admin.js
// Client-side helpers for the admin pages: confirmation dialogs on destructive
// actions, copy-to-clipboard for guest links, the live guest-name search, and
// keeping each badge-award form's action in sync with its select. Loaded by
// the admin views after filter.js. Vanilla JS only; every feature degrades —
// no JS still leaves working forms and a selectable link input.
(function () {
  'use strict';

  // Any form with data-confirm="message" asks the user to confirm before submit.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.getAttribute) {
      return;
    }
    var message = form.getAttribute('data-confirm');
    if (message) {
      var ok = window.confirm(message);
      if (!ok) {
        event.preventDefault();
      }
    }
  });

  // Copy a guest's private link. The readonly input next to the button stays
  // selectable as the fallback when the Clipboard API is unavailable.
  document.addEventListener('click', function (event) {
    var target = event.target;
    var btn = target && target.closest ? target.closest('.copy-link') : null;
    if (!btn) {
      return;
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      return;
    }
    var link = btn.getAttribute('data-link') || '';
    navigator.clipboard.writeText(link).then(function () {
      var row = btn.parentElement;
      var confirmEl = row ? row.querySelector('.copy-confirm') : null;
      if (confirmEl) {
        confirmEl.hidden = false;
        setTimeout(function () {
          confirmEl.hidden = true;
        }, 2000);
      }
    });
  });

  // (The badge-award select needs no JS: it posts action="toggle" and the
  // server resolves award-vs-remove from the guest's current held state.)

  // Live guest search: hide cards whose name doesn't match as the admin
  // types. The matching rule lives in filter.js (window.HuntFilter).
  // Delegated like every other handler in this file, so no load-order or
  // DOM-ready coordination is needed.
  document.addEventListener('input', function (event) {
    var input = event.target;
    if (!input || input.id !== 'guest-search' || !window.HuntFilter) {
      return;
    }
    var q = input.value;
    var cards = document.querySelectorAll('.guest-card');
    cards.forEach(function (card) {
      card.hidden = !window.HuntFilter.nameMatchesQuery(
        card.getAttribute('data-guest-name') || '',
        q
      );
    });
  });
})();
