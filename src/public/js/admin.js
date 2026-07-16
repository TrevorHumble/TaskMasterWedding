// src/public/js/admin.js
// Client-side helpers for the admin pages: confirmation dialogs on destructive
// actions, the live guest-name search, and keeping each badge-award form's
// action in sync with its select. Loaded by the admin views after filter.js.
// Vanilla JS only; every feature degrades — no JS still leaves working forms.
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
