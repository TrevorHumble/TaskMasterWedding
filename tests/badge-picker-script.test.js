// tests/badge-picker-script.test.js
//
// Issue #869 PR review, finding 6: src/public/js/badge-picker.js's
// selectIcon/clearPreview had no test that could fail — reverting either
// back to `previewIcon.src = artPath` / `previewIcon.removeAttribute('src')`
// would silently stop the picker's live preview from recoloring per-theme
// while every other test stayed green. Mirrors tests/admin-tasks-script.
// test.js's jsdom-driven pattern (build a synthetic document matching what
// src/views/partials/badge-picker.ejs actually renders, install window/
// document/navigator as globals, require the real script fresh, drive it
// with dispatched events) — this file covers the picker script specifically
// since it is a separate <script> from admin-tasks.js with its own IIFE.
//
// jsdom (v29, this repo's dependency) does not implement
// HTMLDialogElement.showModal/close — badge-picker.js's own top-level guard
// (`if (!dialog || typeof dialog.showModal !== 'function') return;`) would
// otherwise bail out of the whole IIFE at require time and bind no
// listeners at all. Both are stubbed with minimal open/close state before
// the script is required, same idea as jsdom's own "not implemented" gap
// for <dialog> generally.
'use strict';

const path = require('path');
const { JSDOM } = require('jsdom');

const BADGE_ICON_MASK_JS_PATH = path.join(
  __dirname,
  '..',
  'src',
  'public',
  'js',
  'badge-icon-mask.js'
);
const BADGE_PICKER_JS_PATH = path.join(__dirname, '..', 'src', 'public', 'js', 'badge-picker.js');

// Mirrors src/views/partials/badge-picker.ejs's real shape (dialog id,
// form id, stage/preview ids, grid id, cell/radio/glyph structure) plus one
// external `.badge-choose-btn` (src/public/js/admin-tasks.js normally wires
// this; standing in for it here since this file only drives badge-picker.js).
function pageMarkup() {
  return (
    '<button type="button" class="badge-choose-btn" data-task-id="1" ' +
    'data-task-title="Cake Smash" data-badge-name="Existing Name"></button>' +
    '<dialog id="badge-picker">' +
    '<form id="badge-picker-form">' +
    '<p id="badge-picker-context"></p>' +
    '<span id="badge-preview" class="badge-medallion-empty">' +
    '<span id="badge-preview-icon" hidden></span>' +
    '</span>' +
    '<input type="text" id="badge-picker-name" />' +
    '<input type="search" id="badge-picker-search" />' +
    '<div id="badge-picker-grid">' +
    '<label class="badge-picker-cell" data-name="heart">' +
    '<input type="radio" name="icon" value="favorite" class="badge-picker-radio" data-name="Heart" ' +
    'data-art-path="/badges/icons/favorite.svg" />' +
    '<span class="badge-picker-glyph"></span>' +
    '</label>' +
    '<label class="badge-picker-cell" data-name="star">' +
    '<input type="radio" name="icon" value="star" class="badge-picker-radio" data-name="Star" ' +
    'data-art-path="/badges/icons/star.svg" />' +
    '<span class="badge-picker-glyph"></span>' +
    '</label>' +
    '</div>' +
    '<p id="badge-picker-empty" hidden></p>' +
    '<button type="button" data-picker-close></button>' +
    '<button type="submit" id="badge-picker-save" disabled></button>' +
    '</form>' +
    '</dialog>'
  );
}

/**
 * Build a fresh jsdom document from pageMarkup(), install window/document/
 * navigator as globals, stub <dialog>.showModal/close (jsdom does not
 * implement either), then require badge-icon-mask.js followed by the real
 * badge-picker.js fresh, so its listeners bind to THIS document.
 *
 * `options.tags` (issue #903) stands in for src/public/js/badge-icon-tags.js,
 * which normally assigns window.BadgeIconTags before badge-picker.js loads.
 * Omitted, it defaults to a small known map covering both fixture icons;
 * passed explicitly as `null`, window.BadgeIconTags is left entirely unset,
 * simulating the data file never having loaded (AC5's fallback case). The
 * real map's own shape/coverage is tested separately in
 * tests/badge-icon-tags.test.js -- this fixture only needs to be small and
 * known so a tag-only query can be asserted against exactly.
 */
function loadBadgePicker(options) {
  const opts = options || {};

  const dom = new JSDOM('<!doctype html><html><body>' + pageMarkup() + '</body></html>', {
    url: 'http://localhost/admin/tasks',
  });

  const keys = ['window', 'document', 'navigator'];
  const saved = {};
  keys.forEach((key) => {
    saved[key] = Object.getOwnPropertyDescriptor(global, key);
    Object.defineProperty(global, key, {
      value: dom.window[key],
      configurable: true,
      writable: true,
    });
  });

  const dialogEl = dom.window.document.getElementById('badge-picker');
  dialogEl.showModal = function () {
    this.open = true;
  };
  dialogEl.close = function () {
    this.open = false;
  };

  if (Object.prototype.hasOwnProperty.call(opts, 'tags') && opts.tags === null) {
    delete dom.window.BadgeIconTags;
  } else {
    dom.window.BadgeIconTags = opts.tags || { favorite: ['love', 'romance'], star: ['gold'] };
  }

  delete require.cache[require.resolve(BADGE_ICON_MASK_JS_PATH)];
  require(BADGE_ICON_MASK_JS_PATH);

  delete require.cache[require.resolve(BADGE_PICKER_JS_PATH)];
  require(BADGE_PICKER_JS_PATH);

  function restore() {
    keys.forEach((key) => {
      if (saved[key]) {
        Object.defineProperty(global, key, saved[key]);
      } else {
        delete global[key];
      }
    });
  }

  return { dom, doc: dom.window.document, restore };
}

function click(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('click', { bubbles: true, cancelable: true }));
}

function change(doc, el) {
  el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
}

function typeSearch(doc, el, value) {
  el.value = value;
  el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
}

describe('badge-picker.js (issue #869 PR review, finding 6 — the masked-preview set/clear now has a test that can fail)', () => {
  let doc;
  let restore;

  beforeEach(() => {
    const loaded = loadBadgePicker();
    doc = loaded.doc;
    restore = loaded.restore;
  });

  afterEach(() => {
    restore();
  });

  test('picking an icon radio sets --icon-src on the preview icon, unhides it, and enables Save', () => {
    const previewIcon = doc.getElementById('badge-preview-icon');
    const preview = doc.getElementById('badge-preview');
    const saveBtn = doc.getElementById('badge-picker-save');
    const heartRadio = doc.querySelector('.badge-picker-radio[data-name="Heart"]');

    expect(previewIcon.style.getPropertyValue('--icon-src')).toBe('');
    expect(previewIcon.hidden).toBe(true);
    expect(saveBtn.disabled).toBe(true);

    heartRadio.checked = true;
    change(doc, heartRadio);

    expect(previewIcon.style.getPropertyValue('--icon-src')).toBe(
      "url('/badges/icons/favorite.svg')"
    );
    expect(previewIcon.hidden).toBe(false);
    expect(preview.classList.contains('badge-medallion-empty')).toBe(false);
    expect(saveBtn.disabled).toBe(false);
  });

  test('picking a SECOND icon replaces --icon-src rather than leaving the first one stuck', () => {
    const previewIcon = doc.getElementById('badge-preview-icon');
    const heartRadio = doc.querySelector('.badge-picker-radio[data-name="Heart"]');
    const starRadio = doc.querySelector('.badge-picker-radio[data-name="Star"]');

    heartRadio.checked = true;
    change(doc, heartRadio);
    expect(previewIcon.style.getPropertyValue('--icon-src')).toBe(
      "url('/badges/icons/favorite.svg')"
    );

    starRadio.checked = true;
    change(doc, starRadio);
    expect(previewIcon.style.getPropertyValue('--icon-src')).toBe("url('/badges/icons/star.svg')");
  });

  test('reopening the picker for a new task clears --icon-src from a previous pick (clearPreview, no leak)', () => {
    const previewIcon = doc.getElementById('badge-preview-icon');
    const preview = doc.getElementById('badge-preview');
    const heartRadio = doc.querySelector('.badge-picker-radio[data-name="Heart"]');

    heartRadio.checked = true;
    change(doc, heartRadio);
    expect(previewIcon.style.getPropertyValue('--icon-src')).toBe(
      "url('/badges/icons/favorite.svg')"
    );

    click(doc, doc.querySelector('.badge-choose-btn')); // openFor() -> clearPreview()

    expect(previewIcon.style.getPropertyValue('--icon-src')).toBe('');
    expect(previewIcon.hidden).toBe(true);
    expect(preview.classList.contains('badge-medallion-empty')).toBe(true);
  });
});

describe('badge-picker.js search filter — tag search (issue #903 AC5)', () => {
  test('a query matching only a tag (not the display name) shows that cell and hides the other (AC5)', () => {
    const { doc, restore } = loadBadgePicker();
    const search = doc.getElementById('badge-picker-search');
    const heartCell = doc.querySelector('.badge-picker-cell[data-name="heart"]');
    const starCell = doc.querySelector('.badge-picker-cell[data-name="star"]');

    // 'romance' is one of the Heart fixture's tags (see loadBadgePicker's
    // default map) and appears nowhere in Star's name or tags.
    typeSearch(doc, search, 'romance');

    expect(heartCell.hidden).toBe(false);
    expect(starCell.hidden).toBe(true);

    restore();
  });

  test('a query by display name still matches, tags present or not (AC2)', () => {
    const { doc, restore } = loadBadgePicker();
    const search = doc.getElementById('badge-picker-search');
    const heartCell = doc.querySelector('.badge-picker-cell[data-name="heart"]');
    const starCell = doc.querySelector('.badge-picker-cell[data-name="star"]');

    typeSearch(doc, search, 'star');

    expect(starCell.hidden).toBe(false);
    expect(heartCell.hidden).toBe(true);

    restore();
  });

  test('a query matching no name and no tag hides every cell and shows the empty message (AC3 no-match)', () => {
    const { doc, restore } = loadBadgePicker();
    const search = doc.getElementById('badge-picker-search');
    const heartCell = doc.querySelector('.badge-picker-cell[data-name="heart"]');
    const starCell = doc.querySelector('.badge-picker-cell[data-name="star"]');
    const empty = doc.getElementById('badge-picker-empty');

    typeSearch(doc, search, 'no such icon anywhere');

    expect(heartCell.hidden).toBe(true);
    expect(starCell.hidden).toBe(true);
    expect(empty.hidden).toBe(false);

    restore();
  });

  test('with window.BadgeIconTags entirely absent, the picker still filters by display name without throwing (graceful no-tags fallback, AC5)', () => {
    const { doc, restore } = loadBadgePicker({ tags: null });
    const search = doc.getElementById('badge-picker-search');
    const heartCell = doc.querySelector('.badge-picker-cell[data-name="heart"]');
    const starCell = doc.querySelector('.badge-picker-cell[data-name="star"]');

    expect(() => typeSearch(doc, search, 'heart')).not.toThrow();

    expect(heartCell.hidden).toBe(false);
    expect(starCell.hidden).toBe(true);

    restore();
  });
});
