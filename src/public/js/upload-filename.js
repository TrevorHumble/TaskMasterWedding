// src/public/js/upload-filename.js
// Owns the styled upload control's filename label end to end: the pure text
// helpers (shared by every upload control so the "no file chosen" copy is
// defined once) and the DOM wiring that applies them on the hidden file
// input's change event. Degrades gracefully with no JS: the label still
// opens the picker and the form still submits the file(s), just without the
// filename/count echoed back.
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

// Multiple-aware sibling of uploadLabelText for the batch memory picker
// (issue #364). Pure and DOM-free so it is unit-testable on its own:
//   0 files  -> the caller's resting-state placeholder (the picker's own
//               label text, e.g. "Choose photos…") — never the literal
//               "0 photos selected", and never a filename left over from a
//               prior selection (AC4).
//   1 file   -> that file's name, same as the single-file control (AC3).
//   N (>=2)  -> "N photos selected" (AC2).
//
// @param {ArrayLike<{name: string}>|null|undefined} files - a FileList or array of File-likes
// @param {string} placeholder - resting-state text to show when 0 files are selected
// @returns {string}
function uploadSelectionText(files, placeholder) {
  var count = files ? files.length : 0;
  var resting =
    typeof placeholder === 'string' && placeholder.length > 0 ? placeholder : PLACEHOLDER;

  if (count === 0) {
    return resting;
  }
  if (count === 1) {
    return uploadLabelText(files[0] && files[0].name);
  }
  return count + ' photos selected';
}

if (typeof document !== 'undefined') {
  (function () {
    function init() {
      var inputs = document.querySelectorAll('input[type="file"].visually-hidden');

      inputs.forEach(function (input) {
        var wrap = input.closest('.upload-field');
        var filenameEl = wrap ? wrap.querySelector('.upload-filename') : null;
        if (!filenameEl) return;

        if (input.multiple) {
          // Read the resting-state placeholder from the control's own
          // server-rendered label rather than hardcoding a second copy of
          // "Choose photos…" here — the label is the single source of that
          // string (see upload-field.ejs's `label` local).
          var labelEl = wrap.querySelector('label.btn');
          var placeholder = labelEl ? labelEl.textContent : PLACEHOLDER;

          input.addEventListener('change', function () {
            filenameEl.textContent = uploadSelectionText(input.files, placeholder);
          });
        } else {
          input.addEventListener('change', function () {
            var file = input.files && input.files[0];
            filenameEl.textContent = uploadLabelText(file ? file.name : null);
          });
        }
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
  module.exports.uploadSelectionText = uploadSelectionText;
}
