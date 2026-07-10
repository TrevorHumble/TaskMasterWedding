// src/public/js/memory-caption.js
// Memory-page-scoped enhancement (issue #364 AC7/AC8): a single shared
// caption only makes sense for exactly one photo, so once the batch picker's
// selection reaches 2+ files the caption input is hidden and disabled (so
// its value is not submitted) and a note steers the guest to caption one at
// a time. Deliberately kept out of upload-filename.js — that control is
// generic (label + count) for every upload caller (task/avatar/memory); the
// caption box only exists on the memory form, so its toggle rule lives here.
'use strict';

/**
 * Pure, DOM-free decision for the caption toggle. No fileCount argument other
 * than a non-negative integer is meaningful for this control (the file input
 * always yields a FileList, whose .length is never negative or fractional).
 *
 * @param {number} fileCount
 * @returns {{captionHidden: boolean, captionDisabled: boolean, noteHidden: boolean}}
 */
function captionState(fileCount) {
  var isBatch = fileCount >= 2;
  return {
    captionHidden: isBatch,
    captionDisabled: isBatch,
    noteHidden: !isBatch,
  };
}

if (typeof document !== 'undefined') {
  (function () {
    function init() {
      var input = document.getElementById('photos');
      var captionField = document.getElementById('caption-field');
      var captionInput = document.getElementById('caption');
      var note = document.getElementById('caption-batch-note');
      if (!input || !captionField || !captionInput || !note) return;

      function apply(fileCount) {
        var state = captionState(fileCount);
        captionField.hidden = state.captionHidden;
        captionInput.disabled = state.captionDisabled;
        note.hidden = state.noteHidden;
      }

      input.addEventListener('change', function () {
        apply(input.files ? input.files.length : 0);
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
  module.exports = captionState;
}
