// src/public/js/slideshow-launch.js — opens the "Play slideshow" options
// popup from the admin dashboard (issue #468). Same native-<dialog> pattern as
// the #248 comments dialog: showModal() makes the page inert, the close button
// (data-close-slideshow) and a backdrop click close it, and Escape closes it
// natively. No dependency.
'use strict';

(function () {
  var dialog = document.getElementById('slideshow-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') return;

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
    // Backdrop click: the dialog element is the target only when the click
    // lands on its ::backdrop, outside the panel content.
    if (event.target === dialog && dialog.open) dialog.close();
  });
})();
