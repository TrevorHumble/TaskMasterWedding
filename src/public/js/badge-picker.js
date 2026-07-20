// src/public/js/badge-picker.js
//
// Issue #410: drives the shared badge-picker <dialog> on the tasks admin
// page. The picker is a dense grid of bare icon glyphs; picking one
// "populates" it inside a live badge-ring preview and enables Save. A search
// box filters the grid so the full 200-icon set stays scannable.
//
// The pick persists end-to-end: this form POSTs to /admin/tasks/:id/badge
// (wired server-side in src/routes/admin.js), which validates the chosen
// icon id against src/services/badge-icons.js and stores it as the task's
// badge art_path, rendered on every guest surface via
// src/views/partials/badge-art.ejs. This file owns only the picker
// interaction (preview, search, save-button enablement) — it does not know
// or care how the id is validated or stored server-side.
(function () {
  'use strict';

  var dialog = document.getElementById('badge-picker');
  if (!dialog || typeof dialog.showModal !== 'function') return;

  var form = document.getElementById('badge-picker-form');
  var nameInput = document.getElementById('badge-picker-name');
  var context = document.getElementById('badge-picker-context');
  var search = document.getElementById('badge-picker-search');
  var grid = document.getElementById('badge-picker-grid');
  var empty = document.getElementById('badge-picker-empty');
  var preview = document.getElementById('badge-preview');
  var previewIcon = document.getElementById('badge-preview-icon');
  var saveBtn = document.getElementById('badge-picker-save');
  var cells = Array.prototype.slice.call(form.querySelectorAll('.badge-picker-cell'));

  // The display name the host last accepted as auto-filled, so re-picking a
  // different icon updates the name only while the host hasn't typed their own.
  var autoFilledName = '';

  function clearPreview() {
    preview.classList.add('badge-medallion-empty');
    previewIcon.hidden = true;
    previewIcon.removeAttribute('src');
    saveBtn.disabled = true;
  }

  function selectIcon(radio) {
    var name = radio.getAttribute('data-name') || '';
    previewIcon.src = radio.getAttribute('data-art-path') || '';
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
      var match = !q || (cell.getAttribute('data-name') || '').indexOf(q) !== -1;
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

  // Click on the backdrop (outside the form) closes the dialog.
  dialog.addEventListener('click', function (event) {
    if (event.target === dialog) dialog.close();
  });
})();
