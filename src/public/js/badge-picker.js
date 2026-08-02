// src/public/js/badge-picker.js
//
// Issue #410: drives the shared badge-picker <dialog> on the tasks admin
// page. The picker is a dense grid of bare icon glyphs; picking one
// "populates" it inside a live badge-ring preview and enables Save. A search
// box filters the grid so the full bundled icon set stays scannable.
//
// The pick persists end-to-end: this form POSTs to /admin/tasks/:id/badge
// (wired server-side in src/routes/admin.js), which validates the chosen
// icon id against src/services/badge-icons.js and stores it as the task's
// badge art_path, rendered on every guest surface via
// src/views/partials/badge-art.ejs. This file owns only the picker
// interaction (preview, search, save-button enablement) — it does not know
// or care how the id is validated or stored server-side.
//
// Depends on src/public/js/badge-icon-mask.js (issue #869) being loaded
// first — window.BadgeIconMask.set/clear is the single owner of the
// --icon-src custom property the live preview glyph carries; see that
// file's own header. Also depends on src/public/js/dialog-dismiss.js
// (issue #879) being loaded first — window.DialogDismiss.backdrop is the
// single owner of backdrop-dismiss wiring. src/views/admin-tasks.ejs's
// <script> order is what guarantees both load orders.
(function () {
  'use strict';

  var dialog = document.getElementById('badge-picker');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  var form = document.getElementById('badge-picker-form');
  var nameInput = document.getElementById('badge-picker-name');
  var context = document.getElementById('badge-picker-context');
  var search = document.getElementById('badge-picker-search');
  var empty = document.getElementById('badge-picker-empty');
  var preview = document.getElementById('badge-preview');
  var previewIcon = document.getElementById('badge-preview-icon');
  var saveBtn = document.getElementById('badge-picker-save');
  var cells = Array.prototype.slice.call(form.querySelectorAll('.badge-picker-cell'));

  // Search text per cell: the display name PLUS every tag from
  // badge-icon-tags.js (loaded before this file), so typing any related word
  // ("hangover", "booze", "bride") surfaces the icon, not just its name.
  // Built once here rather than server-rendered into data attributes — the
  // tags are pure search data, and one shared map keeps the picker HTML lean.
  var tagMap = window.BadgeIconTags || {};
  cells.forEach(function (cell) {
    var radio = cell.querySelector('.badge-picker-radio');
    var id = radio ? radio.value : '';
    var tagText = (tagMap[id] || []).join(' ');
    cell.setAttribute(
      'data-search',
      ((cell.getAttribute('data-name') || '') + ' ' + tagText).toLowerCase()
    );
  });

  // The display name the host last accepted as auto-filled, so re-picking a
  // different icon updates the name only while the host hasn't typed their own.
  var autoFilledName = '';

  function clearPreview() {
    preview.classList.add('badge-medallion-empty');
    previewIcon.hidden = true;
    window.BadgeIconMask.clear(previewIcon);
    saveBtn.disabled = true;
  }

  function selectIcon(radio) {
    var name = radio.getAttribute('data-name') || '';
    // The glyph is a CSS-masked box (#869), not an <img>: its shape comes from
    // the icon SVG set as a mask via --icon-src, its color from the theme's
    // --badge-icon-color. badge-icon-mask.js (loaded before this file) is the
    // single owner of that property's set/clear — see its own header.
    var artPath = radio.getAttribute('data-art-path') || '';
    window.BadgeIconMask.set(previewIcon, artPath);
    previewIcon.hidden = false;
    preview.classList.remove('badge-medallion-empty');
    saveBtn.disabled = false;

    // Suggest the icon's name the first time / while the host hasn't overridden.
    if (!nameInput.value || nameInput.value === autoFilledName) {
      nameInput.value = name;
      autoFilledName = name;
    }
  }

  function applyFilter() {
    var q = (search.value || '').trim().toLowerCase();
    var any = false;
    cells.forEach(function (cell) {
      var match = !q || (cell.getAttribute('data-search') || '').indexOf(q) !== -1;
      cell.hidden = !match;
      if (match) any = true;
    });
    empty.hidden = any;
  }

  function openFor(btn) {
    var taskId = btn.getAttribute('data-task-id');
    var title = btn.getAttribute('data-task-title') || '';
    var badgeName = btn.getAttribute('data-badge-name') || '';

    form.setAttribute('action', '/admin/tasks/' + taskId + '/badge');
    context.textContent = title ? 'For “' + title + '”' : '';

    nameInput.value = badgeName;
    autoFilledName = '';

    var checked = form.querySelector('.badge-picker-radio:checked');
    if (checked) checked.checked = false;
    clearPreview();

    search.value = '';
    applyFilter();

    dialog.showModal();
  }

  document.querySelectorAll('.badge-choose-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      openFor(btn);
    });
  });

  form.addEventListener('change', function (event) {
    if (event.target && event.target.classList.contains('badge-picker-radio')) {
      selectIcon(event.target);
    }
  });

  if (search) search.addEventListener('input', applyFilter);

  dialog.querySelectorAll('[data-picker-close]').forEach(function (el) {
    el.addEventListener('click', function () {
      dialog.close();
    });
  });

  // Backdrop dismissal — issue #879's shared module (see
  // src/public/js/dialog-dismiss.js's own header for why a bare
  // event.target === dialog check closed on a drag-select released past the
  // dialog's edge). Guarded (PR review, finding 2): an uncaught TypeError
  // here would be a no-op today since it is the last statement in this IIFE,
  // but the guard is explicit rather than positional so a later addition
  // after this line can't silently reintroduce the coupling.
  if (window.DialogDismiss) window.DialogDismiss.backdrop(dialog);
})();
