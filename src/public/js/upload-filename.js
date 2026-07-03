// src/public/js/upload-filename.js
// Owns the styled upload control's filename label end to end: the pure text
// helper (shared by every upload control so the "no file chosen" copy is
// defined once) and the DOM wiring that applies it on the hidden file
// input's change event. Degrades gracefully with no JS: the label still
// opens the picker and the form still submits the file, just without the
// filename echoed back.
'use strict';

var PLACEHOLDER = 'Choose a photo…';

/**
 * @param {string|null|undefined} fileName
 * @returns {string}  "sunset.jpg" → "sunset.jpg", "" / null / undefined → "Choose a photo…"
 */
function uploadLabelText(fileName) {
  if (typeof fileName === 'string' && fileName.length > 0) {
    return fileName;
  }
  return PLACEHOLDER;
}

if (typeof document !== 'undefined') {
  (function () {
    function init() {
      var inputs = document.querySelectorAll('input[type="file"].visually-hidden');

      inputs.forEach(function (input) {
        var wrap = input.closest('.upload-field');
        var filenameEl = wrap ? wrap.querySelector('.upload-filename') : null;
        if (!filenameEl) return;

        input.addEventListener('change', function () {
          var file = input.files && input.files[0];
          filenameEl.textContent = uploadLabelText(file ? file.name : null);
        });
      });
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  })();
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = uploadLabelText;
}
