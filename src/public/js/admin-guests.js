// src/public/js/admin-guests.js
//
// The admin Guests page's row-opens-a-popup behavior — the same shape
// src/public/js/admin-tasks.js gives the admin Tasks page, so a host meets
// one interaction on both screens instead of two. Before this file, every
// guest row rendered its whole control panel inline (a name form, an
// identity form, a points form, a badge form and a Delete, all always
// visible), which made a 40-guest list unscannable.
//
// One shared <dialog> (views/partials/guest-edit-dialog.ejs) is reused for
// every row: opening it fills the fields from the tapped row's own data-*
// attributes and points the form at that guest's edit URL. Delete is a proxy
// for the row's own hidden, real delete form, so admin.js's delegated
// data-confirm listener still gates it.
//
// Plain ES5-style browser script, no bundler — the convention every other
// file under src/public/js/ follows.
(function () {
  'use strict';

  var dialog = document.getElementById('guest-edit-dialog');
  var form = document.getElementById('guest-edit-form');
  if (!dialog || !form) return;

  var nameInput = document.getElementById('guest-edit-name-input');
  var contactInput = document.getElementById('guest-edit-contact-input');
  var pinInput = document.getElementById('guest-edit-pin-input');
  var coupleInput = document.getElementById('guest-edit-couple-input');
  var blockedInput = document.getElementById('guest-edit-blocked-input');
  var statsEl = document.getElementById('guest-edit-stats');
  var titleEl = document.getElementById('guest-edit-title');
  var photosLink = document.getElementById('guest-edit-photos-link');

  // Which guest the popup is currently editing — the Delete proxy needs it to
  // find that row's own hidden delete form.
  var openGuestId = '';

  if (window.DialogDismiss && typeof window.DialogDismiss.backdrop === 'function') {
    window.DialogDismiss.backdrop(dialog);
  }

  /**
   * Fill the shared popup from `row`'s data-* attributes and open it.
   * @param {Element|null} row - a .guest-card list item
   */
  function openEdit(row, opener) {
    if (!row) return;

    openGuestId = row.getAttribute('data-guest-id') || '';

    // The photos URL rides on the tapped opener rather than being rebuilt
    // here — the view already knows how to compose and escape it, and one
    // owner of that URL means the two can never disagree.
    var photosUrl = opener && opener.getAttribute('data-photos-url');
    if (photosLink && photosUrl) photosLink.setAttribute('href', photosUrl);
    form.setAttribute('action', '/admin/guests/' + openGuestId + '/edit');

    var name = row.getAttribute('data-name') || '';
    if (nameInput) nameInput.value = name;
    if (contactInput) contactInput.value = row.getAttribute('data-contact') || '';
    if (pinInput) pinInput.value = row.getAttribute('data-pin') || '';
    if (coupleInput) coupleInput.checked = row.getAttribute('data-couple') === '1';
    if (blockedInput) blockedInput.checked = row.getAttribute('data-blocked') === '1';

    // The popup's own heading names the guest, so a host who opened the wrong
    // row sees it before typing rather than after saving.
    if (titleEl) titleEl.textContent = name || 'Edit guest';
    if (statsEl) statsEl.innerHTML = row.getAttribute('data-stats') || '';

    if (!dialog.open && typeof dialog.showModal === 'function') dialog.showModal();
  }

  document.addEventListener('click', function (event) {
    var t = event.target;
    if (!t || typeof t.closest !== 'function') return;

    var opener = t.closest('[data-edit-guest]');
    if (opener) {
      openEdit(opener.closest('.guest-card'), opener);
      return;
    }

    var closer = t.closest('[data-dialog-close]');
    if (closer && closer.closest('#guest-edit-dialog')) {
      if (dialog.open && typeof dialog.close === 'function') dialog.close();
      return;
    }

    // Delete: fire the open guest's own real, hidden delete form via
    // requestSubmit(), which dispatches a genuine 'submit' event that
    // admin.js's data-confirm listener can intercept (form.submit() would
    // bypass it entirely). A cancelled confirm() simply leaves the popup open.
    if (t.closest('[data-delete-guest]')) {
      var target = openGuestId
        ? document.querySelector('.guest-delete-form[data-guest-id="' + openGuestId + '"]')
        : null;
      if (target) {
        if (typeof target.requestSubmit === 'function') {
          target.requestSubmit();
        } else {
          target.submit();
        }
      }
      return;
    }
  });
})();
