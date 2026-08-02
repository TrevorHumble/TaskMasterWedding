// src/public/js/slideshow-launch.js — opens the "Play slideshow" options
// popup from the admin dashboard (issue #468). Same native-<dialog> pattern as
// the #248 comments dialog: showModal() makes the page inert, the close button
// (data-close-slideshow) and a backdrop dismissal close it, and Escape closes
// it natively.
//
// Depends on src/public/js/dialog-dismiss.js (issue #879) being loaded
// first — window.DialogDismiss.backdrop is the single owner of
// backdrop-dismiss wiring (see that file's own header for why a bare
// event.target === dialog check closed on a drag-select released past the
// dialog's edge). src/views/admin-dashboard.ejs's <script> order is what
// guarantees the load order.
'use strict';

(function () {
  var dialog = document.getElementById('slideshow-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  // Guarded (PR review, finding 2): this call sits before the
  // document-level click listener below, the SAME listener that opens AND
  // closes this dialog — an uncaught TypeError here (e.g. dialog-dismiss.js
  // failing to load) would leave that listener unregistered and the whole
  // "Play slideshow" feature dead. Guarded, the dialog simply keeps no
  // backdrop-dismiss behavior instead of the whole script dying.
  if (window.DialogDismiss) window.DialogDismiss.backdrop(dialog);

  document.addEventListener('click', function (event) {
    if (!event.target.closest) return;

    if (event.target.closest('[data-open-slideshow]')) {
      if (!dialog.open) dialog.showModal();
      return;
    }
    if (event.target.closest('[data-close-slideshow]')) {
      if (dialog.open) dialog.close();
      return;
    }
  });
})();
