// src/public/js/photo-owner-menu.js
// Progressive enhancement for the owner ⋯ menu (issue #387), loaded on the
// feed and photo-detail pages. The menu itself is a native <details>/<summary>
// that opens with no JS, and Delete is a plain POST <form>. This file adds two
// enhancements, both mirroring src/public/js/feed.js:
//   1. Edit caption: the trigger opens that photo's own native <dialog>
//      (caption-dialog-<submissionId>) via showModal() — the same modal
//      pattern the comments thread uses — closing on Cancel or a backdrop click.
//   2. Delete confirm: a delegated submit listener runs window.confirm on the
//      .photo-owner-delete-form's data-confirm message before the POST. There
//      is no app-wide data-confirm handler on these pages (admin.js is
//      admin-only; feed.js scopes its confirm to .comment-delete-form), so this
//      script owns the photo-delete confirm, exactly as feed.js owns the
//      comment-delete confirm.
'use strict';

(function () {
  if (typeof document === 'undefined') {
    return;
  }

  // Delete confirm: mirror feed.js's comment-delete confirm. Delegated so it
  // covers every .photo-owner-delete-form on the page with no per-form wiring.
  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form || !form.classList || !form.classList.contains('photo-owner-delete-form')) {
      return;
    }
    var message = form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
    }
  });

  document.addEventListener('click', function (event) {
    var opener = event.target.closest && event.target.closest('[data-edit-caption]');
    if (opener) {
      var id = opener.getAttribute('data-edit-caption');
      var dialog = document.getElementById('caption-dialog-' + id);
      // Close the ⋯ menu behind the popup so it isn't left hanging open.
      var menu = opener.closest('details.photo-owner-menu');
      if (menu) {
        menu.open = false;
      }
      if (dialog && !dialog.open && typeof dialog.showModal === 'function') {
        dialog.showModal();
        var textarea = dialog.querySelector('textarea[name="caption"]');
        if (textarea) {
          textarea.focus();
        }
      }
      return;
    }

    var closer = event.target.closest && event.target.closest('[data-close-caption]');
    if (closer) {
      var d = closer.closest('dialog');
      if (d && typeof d.close === 'function') {
        d.close();
      }
      return;
    }

    // Backdrop click: the dialog element is the target only when the click
    // lands on its ::backdrop, not on its children.
    var target = event.target;
    if (
      target.classList &&
      target.classList.contains('caption-dialog') &&
      typeof target.close === 'function'
    ) {
      target.close();
    }
  });
})();
