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

  // Selection/focus highlight (issue #922): this cell is the radio's PARENT,
  // which no sibling CSS combinator can reach, so this script is the single
  // owner of both state classes admin-tasks.css reads — replacing the
  // `:has(.badge-picker-radio:checked)` / `:has(.badge-picker-radio:focus-
  // visible)` rules that used to read the radios directly. See that file's
  // own comment for why a `:has()`-less phone browser needed this fixed.
  var CELL_SELECTED = 'badge-picker-cell-selected';
  var CELL_FOCUS = 'badge-picker-cell-focus';

  // Whether this engine can parse `:focus-visible` at all, probed once.
  // matches() THROWS a SyntaxError on a selector it cannot parse rather than
  // returning false, and an unsupported pseudo-class is a parse error — so on
  // the pre-15.4 Safari this issue exists to serve, an unguarded call would
  // raise an uncaught exception on every focus and every keypress. Probing
  // once is also cheaper than a try/catch on each of those events. The engines
  // that fail this probe simply get no focus ring, which is what they render
  // today.
  var SUPPORTS_FOCUS_VISIBLE = (function () {
    try {
      document.createElement('input').matches(':focus-visible');
      return true;
    } catch (_e) {
      return false;
    }
  })();

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

  // Focus ring, wired separately from the search-text pass above so the two
  // concerns stay findable on their own.
  //
  // Sampled on `focus`, `blur` AND `keydown` — not `focus` alone, which would
  // paint the ring on a finger tap on every engine (a real visible change
  // forbidden by this issue's render-identical premise; the same reasoning
  // src/public/css/guest.css:1503-1505 already documents for :focus-visible
  // generally). A host who clicks a cell (focus lands WITHOUT :focus-visible)
  // and then presses an arrow or Enter is promoted to :focus-visible by the
  // browser with no new `focus` event — the `keydown` sample is what keeps the
  // class live for that promotion instead of stuck at its focus-time snapshot.
  // Both events route through one sampler so the two can never drift apart.
  cells.forEach(function (cell) {
    var radio = cell.querySelector('.badge-picker-radio');
    if (!radio) return;

    function syncFocusCell() {
      cell.classList.toggle(CELL_FOCUS, SUPPORTS_FOCUS_VISIBLE && radio.matches(':focus-visible'));
    }

    radio.addEventListener('focus', syncFocusCell);
    radio.addEventListener('keydown', syncFocusCell);
    radio.addEventListener('blur', function () {
      cell.classList.remove(CELL_FOCUS);
    });
  });

  // Clears the selected-cell class from every cell, then (if `radio` is
  // given) sets it on that radio's own cell — the single place both
  // `selectIcon` (a real pick) and `openFor` (the programmatic uncheck on
  // reopen, which fires no `change` event) route through, so a reopened
  // dialog never strands a previous task's highlight on a cell the host
  // never touched this time.
  function setSelectedCell(radio) {
    cells.forEach(function (cell) {
      cell.classList.remove(CELL_SELECTED);
    });
    var cell = radio && radio.closest('.badge-picker-cell');
    if (cell) cell.classList.add(CELL_SELECTED);
  }

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
    setSelectedCell(radio);

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
    // Programmatic uncheck fires no `change` event, so `selectIcon` never
    // runs here — this is the OTHER path (AC3) that must clear the selected-
    // cell class, or a reopened dialog would strand the previous task's
    // highlight on a cell the host never touched this time.
    setSelectedCell(null);
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
