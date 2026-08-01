// src/public/js/badge-icon-mask.js
//
// Issue #869: the SINGLE owner of the client-side `--icon-src` custom-
// property encoding — the live-preview half of the masked-glyph recolor
// (src/services/badge-icons.js's iconMaskStyle owns the server-rendered
// half; see that function's doc comment for the shared contract:
// .badge-medallion-icon / .badge-picker-glyph in admin-tasks.css mask an
// element's `--icon-src` and fill from --badge-icon-color, instead of an
// <img src> baking a color into the served file).
//
// Before this file existed, src/public/js/badge-picker.js's selectIcon and
// src/public/js/admin-tasks.js's reflectBadge each hand-wrote
// `el.style.setProperty('--icon-src', "url('" + artPath + "')")` — two
// copies of the same string-building rule with no shared owner, so a
// future change to it (e.g. matching the server encoder's CSS-escaping)
// could fix one call site and silently miss the other. Both files now call
// setBadgeIconMask/clearBadgeIconMask here instead.
//
// Plain ES5-style browser script, no bundler — same convention as every
// other file under src/public/js/, loaded via a bare <script defer> tag
// (src/views/admin-tasks.ejs) before badge-picker.js and admin-tasks.js,
// its only two consumers.
(function (global) {
  'use strict';

  /**
   * Set `el`'s `--icon-src` custom property to `url('<artPath>')`, the mask
   * source the CSS rule reads. A falsy artPath clears the property instead
   * (same as clearBadgeIconMask) rather than emitting `url('')`, which
   * would mask the box down to nothing rather than falling back to
   * `--icon-src, none` (admin-tasks.css's default for the empty/hidden state).
   *
   * Unlike the server-side encoder (src/services/badge-icons.js's
   * iconMaskStyle), this does not need to defend against a hostile
   * artPath: every caller here reads it from a `data-art-path` attribute
   * this same app already rendered (badge-picker.ejs's catalog-sourced
   * `ic.artPath`), never from user-typed input.
   *
   * @param {Element|null|undefined} el
   * @param {string|null|undefined} artPath
   */
  function setBadgeIconMask(el, artPath) {
    if (!el) return;
    if (artPath) {
      el.style.setProperty('--icon-src', "url('" + artPath + "')");
    } else {
      el.style.removeProperty('--icon-src');
    }
  }

  /**
   * Clear `el`'s `--icon-src` custom property (the empty/no-badge-picked
   * preview state).
   *
   * @param {Element|null|undefined} el
   */
  function clearBadgeIconMask(el) {
    if (!el) return;
    el.style.removeProperty('--icon-src');
  }

  global.BadgeIconMask = {
    set: setBadgeIconMask,
    clear: clearBadgeIconMask,
  };
})(typeof window !== 'undefined' ? window : this);
