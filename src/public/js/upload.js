// src/public/js/upload.js
//
// Serves three forms: the task-photo upload (#photo on task.ejs), the
// profile-edit avatar upload (#avatar on me-edit.ejs / join.ejs), and the
// share-a-memory batch upload (#photos on memory-new.ejs). Only one is
// present per page. This file owns:
//   1. Live filename-independent image preview for whichever input is present
//      (#photo, #avatar, or #photos — the last widened onto this shared path
//      by issue #990, alongside an onerror fallback and updated alt copy).
//   2. Pure, DI-friendly downscale helpers (computeTargetSize, shouldDownscale,
//      downscaleImage) used ONLY by the task-photo submit flow (issue #254).
//   3. An idempotent fetch-intercepting submit handler scoped to the task
//      form's #photo input (issue #254). The avatar form's separate
//      memory-storage server flow is untouched — this handler never binds to it.
//   4. The memory form's non-intercepted native-submit uploading state
//      (initMemorySubmit, issue #990): unlike #3, it never calls
//      preventDefault — the browser's own multipart POST proceeds untouched
//      (AC6, no-JS parity) — it only toggles the submit button's disabled/
//      label state while that POST is in flight, plus a pageshow reset.
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

/**
 * Put a submit button into its in-flight "uploading" state: disabled, its
 * label swapped, and the shared styling hook added. Shared by initTaskSubmit
 * (fetch-intercepted) and initMemorySubmit (native submit) so the two flows'
 * button mechanics can't drift — each keeps its own trigger for calling this.
 * @param {HTMLButtonElement} btn
 * @param {string} label
 */
function setUploadingState(btn, label) {
  btn.disabled = true;
  btn.textContent = label;
  btn.classList.add('btn-uploading');
}

/**
 * Restore a submit button from the uploading state set by setUploadingState
 * above: enabled, original label, styling hook removed.
 * @param {HTMLButtonElement} btn
 * @param {string} label
 */
function clearUploadingState(btn, label) {
  btn.disabled = false;
  btn.textContent = label;
  btn.classList.remove('btn-uploading');
}

function initPreview() {
  // Issue #990 AC2: the memory-share form's picker (#photos, multiple files)
  // previews the same way the task/avatar single-file pickers already do —
  // same element, same behavior, first selected file only.
  var input =
    document.getElementById('photo') ||
    document.getElementById('avatar') ||
    document.getElementById('photos');
  var preview = document.getElementById('upload-preview');

  if (!input || !preview) {
    return; // No upload form on this page.
  }

  // Idempotent guard: upload.js is loaded twice on both task.ejs and
  // me-edit.ejs (each has a direct <script> tag AND passes pageScript:
  // 'upload.js' to its route, so footer.ejs's pageScript mechanism adds a
  // second tag) — /memories/new loads it once, via a single direct tag,
  // and passes no pageScript. The guard stays regardless of how many times
  // a given page loads the script, so it is correct either way. Without it,
  // a double load's addEventListener would double-bind the change listener.
  if (input.dataset.previewBound === 'true') {
    return;
  }
  input.dataset.previewBound = 'true';

  // A file with an empty `type` (some mobile camera-roll pickers omit it)
  // slips the image-type guard below and reaches an <img> src it can't
  // decode, leaving a broken-image icon on screen. Hide the slot instead.
  preview.onerror = function () {
    preview.hidden = true;
    preview.removeAttribute('src');
  };

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
    preview.alt = 'Preview of the first photo you selected';
  });
}

// The one message for every failure this client cannot name more precisely
// (issue #932): a 5xx, an unmapped status, a network drop, an internal
// TypeError. Named once so the two places that render it cannot drift apart.
var GENERIC_UPLOAD_ERROR = 'That photo could not be uploaded. Please try again.';

/**
 * Wrap guest-readable copy in an Error the submit chain's .catch can tell
 * apart from an engine-authored rejection (issue #932). Without this marker
 * the catch cannot distinguish "the string I threw two lines ago, written for
 * a guest" from "the browser's own network-failure wording" — and it renders
 * whatever it gets straight into the page.
 * @param {string} message - copy the guest is meant to read
 * @returns {Error}
 */
function guestFacingError(message) {
  var err = new Error(message);
  err.guestFacing = true;
  return err;
}

/**
 * How long a throttled guest should wait, in words, taken from the server's
 * own `Retry-After` header (issue #932).
 *
 * The alternative — naming the configured cap in the copy ("20 uploads per 10
 * minutes") — restates a fact `config.js` owns via RATE_LIMIT_UPLOAD_MAX /
 * RATE_LIMIT_WINDOW_MS, and gets it wrong even at stock config: that budget is
 * ONE per-guest counter shared across the photo submit, profile edit, and
 * avatar delete routes, so a guest who edited their profile is throttled well
 * short of any number this copy could quote. src/middleware/rate-limit.js
 * already computes the real seconds remaining and sends them; read that
 * instead of guessing.
 *
 * @param {Response} response - the 429 whose Retry-After to read
 * @returns {string} a phrase that completes "Please wait ___."
 */
function retryWaitPhrase(response) {
  var headers = response && response.headers;
  var raw = headers && typeof headers.get === 'function' ? headers.get('Retry-After') : null;
  var seconds = parseInt(raw, 10);
  // No header, an unparseable one, or the HTTP-date form a foreign proxy may
  // send instead of seconds: say something true but vague rather than a number
  // that would be invented.
  if (!isFinite(seconds) || seconds <= 0) {
    return 'a few minutes';
  }
  var minutes = Math.ceil(seconds / 60);
  return minutes <= 1 ? 'about a minute' : 'about ' + minutes + ' minutes';
}

// Guest-facing copy for the status classes this client can name (issue #932),
// owner-approved. Every value is a function of the response so the 429 case
// can read the wait the server actually computed; the other three ignore
// their argument. The 404 copy stays neutral about cause: the same status
// covers both a task deactivated mid-party and a malformed task id, and the
// client cannot tell which.
var MESSAGES_BY_STATUS = {
  403: function () {
    return 'Session hiccup. Refresh this page and try again.';
  },
  404: function () {
    return "This task isn't available anymore.";
  },
  413: function () {
    return 'That photo is too large. Try a smaller one.';
  },
  429: function (response) {
    return (
      'Too many uploads in a row. Please wait ' +
      retryWaitPhrase(response) +
      '. Our little site needs a breather. Thanks!'
    );
  },
};

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

    setUploadingState(submitBtn, uploadingLabel);
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
        // redirect:'manual' — do NOT let fetch transparently follow the
        // server's redirect. The submit endpoint answers success (and its
        // validation flashes) with a redirect that ALSO sets a ONE-SHOT
        // cookie: the #255 task-complete reward (success card + badge modal)
        // or a flash message. If fetch followed the redirect here, that
        // follow-up GET would consume the one-shot cookie on a response we
        // then discard, so the real page load below would render with the
        // cookie already spent — no success card, no badge modal, no flash.
        // Leaving the redirect unfollowed keeps the cookie unspent; the full
        // navigation below consumes it in a page context where the page's
        // scripts (js/badge-moment.js) actually run.
        // Issue #284: the CSRF header, merged in alongside the form's own
        // hidden _csrf field (already inside formData via `new
        // FormData(form)` above, since partials/csrf-field.ejs renders it as
        // the form's first field) — belt and suspenders, matching every
        // other write-fetch in this app.
        return fetch(form.action, {
          method: 'POST',
          body: formData,
          redirect: 'manual',
          headers: window.csrfHeader ? window.csrfHeader() : {},
        });
      })
      .then(function (response) {
        // The normal outcome (success, replace, or a validation flash) is a
        // redirect, which redirect:'manual' surfaces as an opaque-redirect
        // response. Do a real navigation to the task page so the browser
        // consumes the one-shot cookie and runs badge-moment.js. The redirect
        // always targets this task's page (form action minus the /submit).
        //
        // Issue #932: on an engine or venue proxy that transparently follows
        // the redirect despite redirect:'manual', the same success comes back
        // as an ordinary ok response instead — treat that as success too,
        // never as a failure (a false "try again" here invites a duplicate
        // submission). Whatever one-shot cookie the redirect carried was
        // already spent by that followed GET, so this upload skips it: the
        // task-complete card on a success, or — since the four flash-and-
        // redirect failure paths in POST /tasks/:id/submit look identical
        // from here — the error flash the server set on a rejected upload,
        // leaving that guest to navigate with nothing shown. Accepted
        // degradation on this engine class only, with the reasoning in the
        // issue's "Recorded degradations on the followed-redirect engine".
        if (response.type === 'opaqueredirect' || response.ok) {
          window.location = form.getAttribute('action').replace(/\/submit$/, '');
          return;
        }
        // A non-redirect answer is an error the endpoint (or a proxy in
        // front of it) rendered directly. Map the known status classes to
        // what the guest should actually DO; anything else keeps the
        // generic copy. hasOwnProperty, not a bare lookup: a status that
        // happened to name an Object.prototype member would otherwise
        // resolve to an inherited function and print its source into the
        // page — the exact outcome the .catch below exists to prevent.
        var buildMessage = Object.prototype.hasOwnProperty.call(MESSAGES_BY_STATUS, response.status)
          ? MESSAGES_BY_STATUS[response.status]
          : null;
        throw guestFacingError(buildMessage ? buildMessage(response) : GENERIC_UPLOAD_ERROR);
      })
      .catch(function (err) {
        clearUploadingState(submitBtn, originalLabel);
        if (errorEl) {
          // Only an error THIS handler authored carries copy fit for a
          // guest to read. Anything else reaching here is an engine-authored
          // rejection — a real network drop rejects with the browser's own
          // wording ("Failed to fetch", "NetworkError when attempting to
          // fetch resource"), and a bug in the code above would arrive as a
          // TypeError. Printing either into the page would put developer
          // text in front of a guest, so those all fall back to the one
          // generic line.
          errorEl.textContent =
            err && err.guestFacing && err.message ? err.message : GENERIC_UPLOAD_ERROR;
          errorEl.hidden = false;
        }
      });
  });
}

/**
 * Wires the memory-share form's (#photos) submit: a native, non-intercepted
 * submit — unlike the task form's fetch-based initTaskSubmit above — that
 * only toggles the button's uploading state (disabled + the label from
 * data-uploading-label) while the browser's own POST is in flight, plus a
 * pageshow reset so a bfcache back-navigation to this page never shows a
 * dead "Sharing…" button (issue #990 AC4/AC5).
 *
 * Scoped to the memory form only: #photos is unique to memory-new.ejs. The
 * task form's uploading state stays owned entirely by initTaskSubmit (its
 * fetch-intercepted flow already disables/relabels its own button).
 */
function initMemorySubmit() {
  var photosInput = document.getElementById('photos');
  if (!photosInput) {
    return; // Not the memory-share page (also excludes the task/avatar forms).
  }
  var form = photosInput.closest('form');
  if (!form) {
    return;
  }
  var submitBtn = form.querySelector('button[type="submit"]');
  if (!submitBtn) {
    return;
  }

  // Idempotent guard: same convention as initPreview/initTaskSubmit above,
  // so a second script load (were this page ever to gain a footer
  // pageScript) can't double-bind the submit/pageshow listeners.
  if (form.dataset.memorySubmitBound === 'true') {
    return;
  }
  form.dataset.memorySubmitBound = 'true';

  var originalLabel = submitBtn.textContent;

  form.addEventListener('submit', function () {
    if (submitBtn.disabled) {
      return; // Already in flight.
    }
    var uploadingLabel = submitBtn.getAttribute('data-uploading-label') || 'Sharing…';
    setUploadingState(submitBtn, uploadingLabel);
    // No preventDefault/fetch: the browser's own POST carries the multipart
    // body exactly as a no-JS submit would (AC6) — this handler is
    // presentation-only, unlike initTaskSubmit's intercepted flow.
    //
    // Deliberately no timeout-based reset here (issue #990, Recorded
    // omissions: "Stalled-POST recovery"). If the native POST never
    // completes on this document (stopped load, wifi stall with no error
    // navigation), the button stays disabled reading "Sharing…" until
    // reload — re-enabling it mid-upload on a guess would invite a
    // duplicate submit of the same batch. A reload, or the server's own
    // response navigation (the normal case), is what clears it.
  });

  // AC5: a bfcache restore (back-navigation) re-shows this exact DOM without
  // re-running init(), so a prior in-flight "Sharing…" state must be reset
  // here rather than relying on a fresh page load to clear it. Gated on
  // evt.persisted so this only fires for an actual bfcache restore, not
  // every ordinary pageshow (which also fires after a normal fresh load).
  window.addEventListener('pageshow', function (evt) {
    if (!evt.persisted) {
      return;
    }
    clearUploadingState(submitBtn, originalLabel);
  });
}

function init() {
  initPreview();
  initTaskSubmit();
  initMemorySubmit();
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
