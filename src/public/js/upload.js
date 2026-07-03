// src/public/js/upload.js
(function () {
  'use strict';

  function init() {
    // Serves two forms: the task-photo upload (#photo on task.ejs) and the
    // profile-edit avatar upload (#avatar on me-edit.ejs). Only one is present per page.
    var input = document.getElementById('photo') || document.getElementById('avatar');
    var preview = document.getElementById('upload-preview');

    if (!input || !preview) {
      return; // No upload form on this page.
    }

    var lastObjectUrl = null;

    input.addEventListener('change', function () {
      // Clean up any previous object URL to avoid memory leaks.
      if (lastObjectUrl) {
        URL.revokeObjectURL(lastObjectUrl);
        lastObjectUrl = null;
      }

      var file = input.files && input.files[0];
      if (!file) {
        preview.hidden = true;
        preview.removeAttribute('src');
        return;
      }

      // Only preview image files.
      if (file.type && file.type.indexOf('image/') !== 0) {
        preview.hidden = true;
        preview.removeAttribute('src');
        return;
      }

      lastObjectUrl = URL.createObjectURL(file);
      preview.src = lastObjectUrl;
      preview.hidden = false;
      preview.alt = 'Preview of the photo you selected';
    });
  }

  // The script is loaded with defer, but guard anyway for safety.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
