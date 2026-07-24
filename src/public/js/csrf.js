// src/public/js/csrf.js
// Issue #284: the one place client JS reads the CSRF token, off the
// <meta name="csrf-token"> tag partials/head.ejs renders on every page. Every
// other script in this app that fires a write fetch() (upload.js, feed.js,
// recap.js, admin-tasks.js) merges window.csrfHeader() into that call's
// headers instead of re-reading the meta tag itself, so there is one owner of
// "how does a script find the token" — the same reuse-a-single-owner rule
// this app already applies to cookie options (session.js's cookieOpts) and
// the guest/IP rate-limit key (rate-limit.js's guestOrIpKey).
//
// Reads the meta tag FRESH on every call rather than caching it at load time:
// this file is loaded once per page (footer.ejs, ahead of every other
// script — see that file's comment), but nothing about it depends on the DOM
// being ready, since the read only happens inside the functions below, at
// whatever later moment a write actually fires.
(function () {
  'use strict';

  function csrfToken() {
    var meta = document.querySelector('meta[name="csrf-token"]');
    return meta ? meta.content : '';
  }

  function csrfHeader() {
    return { 'X-CSRF-Token': csrfToken() };
  }

  window.csrfToken = csrfToken;
  window.csrfHeader = csrfHeader;
})();
