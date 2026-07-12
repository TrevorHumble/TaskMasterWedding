// src/public/js/upload.js
//
// Serves two forms: the task-photo upload (#photo on task.ejs) and the
// profile-edit avatar upload (#avatar on me-edit.ejs / join.ejs). Only one
// is present per page. This file owns:
//   1. Live filename-independent image preview for whichever input is present
//      (pre-existing behavior, unchanged).
//   2. Pure, DI-friendly downscale helpers (computeTargetSize, shouldDownscale,
//      downscaleImage) used ONLY by the task-photo submit flow (issue #254).
//   3. An idempotent fetch-intercepting submit handler scoped to the task
//      form's #photo input (issue #254). The avatar form's separate
//      memory-storage server flow is untouched — this handler never binds to it.
'use strict';

// ---------------------------------------------------------------------------
// Pure geometry/threshold helpers (no DOM). Exported for direct unit testing
// and reused by downscaleImage below.
// ---------------------------------------------------------------------------

var DEFAULT_DOWNSCALE_OPTS = {
  maxEdge: 2000,
  maxBytes: 2.5 * 1024 * 1024, // 2.5MB
  quality: 0.85,
};

/**
 * Compute the output width/height for an image whose long edge must not
 * exceed maxEdge, preserving aspect ratio. Images already within the limit
 * are returned unchanged (never upscaled).
 * @param {number} width
 * @param {number} height
 * @param {number} maxEdge
 * @returns {{width:number,height:number}}
 */
function computeTargetSize(width, height, maxEdge) {
  var longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) {
    return { width: width, height: height };
  }
  var scale = maxEdge / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decide whether an image needs downscaling: either dimension exceeds
 * maxEdge, or the file is already over maxBytes (re-encoding at the JPEG
 * quality below usually shrinks it even at the same dimensions).
 * @param {number} width
 * @param {number} height
 * @param {number} fileSize - bytes
 * @param {{maxEdge:number,maxBytes:number}} opts
 * @returns {boolean}
 */
function shouldDownscale(width, height, fileSize, opts) {
  return width > opts.maxEdge || height > opts.maxEdge || fileSize > opts.maxBytes;
}

/**
 * Build the real-browser primitives downscaleImage needs. Constructed lazily
 * (only when downscaleImage actually runs without an injected env) so this
 * module can be `require()`d under Node/vitest, where `document`/`Image`
 * don't exist, without throwing at load time.
 */
function defaultEnv() {
  return {
    loadImage: function (file) {
      if (typeof createImageBitmap === 'function') {
        return createImageBitmap(file);
      }
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(file);
        var img = new Image();
        img.onload = function () {
          img._objectUrl = url;
          resolve(img);
        };
        img.onerror = function () {
          URL.revokeObjectURL(url);
          reject(new Error('Could not decode image for downscaling.'));
        };
        img.src = url;
      });
    },
    createCanvas: function (width, height) {
      var canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    toBlob: function (canvas, type, quality) {
      return new Promise(function (resolve) {
        canvas.toBlob(resolve, type, quality);
      });
    },
    createFile: function (parts, name, opts) {
      return new File(parts, name, opts);
    },
    revokeImage: function (image) {
      if (image && image._objectUrl) {
        URL.revokeObjectURL(image._objectUrl);
      }
      if (image && typeof image.close === 'function') {
        image.close(); // ImageBitmap
      }
    },
  };
}

/**
 * Downscale a File to a JPEG whose long edge is <= opts.maxEdge, re-encoded
 * at opts.quality, IF the file exceeds opts.maxEdge in either dimension or
 * opts.maxBytes in size. Files already under both thresholds are returned
 * unchanged (identity, not a copy) — see AC5.
 *
 * The final `env` parameter carries the image-decode + canvas primitives so
 * this function is testable under vitest+jsdom, which has no canvas backend
 * (HTMLCanvasElement.getContext/toBlob are no-ops there). Real callers omit
 * it and get the browser defaults; tests inject fakes.
 *
 * @param {File} file
 * @param {{maxEdge?:number,maxBytes?:number,quality?:number}} [opts]
 * @param {{loadImage:Function,createCanvas:Function,toBlob:Function,createFile:Function,revokeImage?:Function}} [env]
 * @returns {Promise<File>}
 */
function downscaleImage(file, opts, env) {
  var options = {
    maxEdge: (opts && opts.maxEdge) || DEFAULT_DOWNSCALE_OPTS.maxEdge,
    maxBytes: (opts && opts.maxBytes) || DEFAULT_DOWNSCALE_OPTS.maxBytes,
    quality: (opts && opts.quality) || DEFAULT_DOWNSCALE_OPTS.quality,
  };
  var e = env || defaultEnv();

  return Promise.resolve(e.loadImage(file)).then(function (image) {
    var needsDownscale = shouldDownscale(image.width, image.height, file.size, options);
    if (!needsDownscale) {
      if (e.revokeImage) e.revokeImage(image);
      return file;
    }

    var target = computeTargetSize(image.width, image.height, options.maxEdge);
    var canvas = e.createCanvas(target.width, target.height);
    var ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0, target.width, target.height);

    return Promise.resolve(e.toBlob(canvas, 'image/jpeg', options.quality)).then(function (blob) {
      if (e.revokeImage) e.revokeImage(image);

      // Guard against a pathological re-encode that comes out no smaller
      // (e.g. a photo already heavily compressed at large dimensions) —
      // keep the original rather than upload something no better.
      if (!blob || blob.size >= file.size) {
        return file;
      }

      var baseName = (file.name || 'photo').replace(/\.\w+$/, '');
      return e.createFile([blob], baseName + '.jpg', { type: 'image/jpeg' });
    });
  });
}

// ---------------------------------------------------------------------------
// DOM wiring.
// ---------------------------------------------------------------------------

function initPreview() {
  var input = document.getElementById('photo') || document.getElementById('avatar');
  var preview = document.getElementById('upload-preview');

  if (!input || !preview) {
    return; // No upload form on this page.
  }

  // Idempotent guard: upload.js is loaded twice per page that uses this
  // form (direct <script> tag + footer's pageScript). Without this, the
  // second load's addEventListener would double-bind the change listener.
  if (input.dataset.previewBound === 'true') {
    return;
  }
  input.dataset.previewBound = 'true';

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

/**
 * Wires the task form's (#photo) submit: downscale -> fetch -> follow
 * redirect, with an uploading state on the button and idempotent binding
 * (task.ejs loads this script twice — directly and via footer's pageScript —
 * so this MUST be safe to call more than once).
 *
 * Scoped to the task form only: the avatar form (#avatar) has a different
 * server flow (memory storage, different redirect) and is untouched here.
 */
function initTaskSubmit() {
  var photoInput = document.getElementById('photo');
  if (!photoInput) {
    return; // Not the task page (also excludes the avatar form).
  }
  var form = photoInput.closest('form');
  if (!form) {
    return;
  }

  // Idempotent guard: upload.js is loaded twice per task page (direct
  // <script> tag + footer's pageScript). Without this, the second load's
  // addEventListener would double-bind and an intercepted submit would fire
  // fetch twice, double-uploading.
  if (form.dataset.uploadBound === 'true') {
    return;
  }

  // No-JS-equivalent baseline: if fetch/FormData aren't available, leave the
  // form as a plain native POST (progressive enhancement only).
  if (typeof fetch !== 'function' || typeof FormData !== 'function') {
    return;
  }

  form.dataset.uploadBound = 'true';

  var submitBtn = form.querySelector('button[type="submit"]');
  if (!submitBtn) {
    return;
  }
  var errorEl = document.getElementById('upload-error');

  form.addEventListener('submit', function (evt) {
    evt.preventDefault();

    if (submitBtn.disabled) {
      return; // Already in flight.
    }

    var originalLabel = submitBtn.textContent;
    var uploadingLabel = submitBtn.getAttribute('data-uploading-label') || 'Uploading…';

    submitBtn.disabled = true;
    submitBtn.textContent = uploadingLabel;
    submitBtn.classList.add('btn-uploading');
    if (errorEl) {
      errorEl.hidden = true;
      errorEl.textContent = '';
    }

    var file = photoInput.files && photoInput.files[0];

    var prepared = file
      ? downscaleImage(file).catch(function () {
          // Downscale failed (e.g. an undecodable image) — fall back to the
          // original file rather than blocking the submission; the server's
          // own validation is the source of truth on acceptance.
          return file;
        })
      : Promise.resolve(null);

    prepared
      .then(function (finalFile) {
        var formData = new FormData(form);
        if (finalFile) {
          formData.set('photo', finalFile, finalFile.name || 'photo.jpg');
        }
        return fetch(form.action, { method: 'POST', body: formData });
      })
      .then(function (response) {
        if (!response.ok) {
          throw new Error('That photo could not be uploaded. Please try again.');
        }
        window.location = response.url;
      })
      .catch(function (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalLabel;
        submitBtn.classList.remove('btn-uploading');
        if (errorEl) {
          errorEl.textContent =
            (err && err.message) || 'That photo could not be uploaded. Please try again.';
          errorEl.hidden = false;
        }
      });
  });
}

function init() {
  initPreview();
  initTaskSubmit();
}

// The script is loaded with defer, but guard anyway for safety.
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeTargetSize: computeTargetSize,
    shouldDownscale: shouldDownscale,
    downscaleImage: downscaleImage,
  };
}
