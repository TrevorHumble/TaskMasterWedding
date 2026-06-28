// src/public/js/admin.js
// Client-side helpers for the admin pages: confirmation dialogs on destructive
// actions. Loaded by the footer partial on admin views. Vanilla JS only.
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

  // Reorder helper: the Tasks page has "up"/"down" buttons. Each button posts a
  // hidden form. Nothing extra is needed here, but we keep a no-op hook so the
  // file is the single place to extend admin behavior later.
})();
