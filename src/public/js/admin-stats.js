// src/public/js/admin-stats.js — the Through-the-weekend day picker (issue
// #1022). The approved screen carries no submit button (the mock's picker is
// markup-only), so the wrapping GET form submits itself on the select's
// `change`, matching this admin surface's existing reliance on client JS for
// a control with no visible submit (the slideshow launcher, the recap panel).
'use strict';

(function () {
  var select = document.getElementById('stats-day');
  if (!select) return;

  select.addEventListener('change', function () {
    var form = select.closest('form');
    if (form) form.submit();
  });
})();
