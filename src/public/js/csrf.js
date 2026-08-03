// src/public/js/csrf.js
// Issue #284: the one place client JS reads the CSRF token, off the
// <meta name="csrf-token"> tag partials/head.ejs renders on every page. Every
// other script in this app that fires a write fetch() merges window.csrfHeader()
// into that call's headers instead of re-reading the meta tag itself, so there
// is one owner of "how does a script find the token" -- the same
// reuse-a-single-owner rule this app already applies to cookie options
// (session.js's cookieOpts) and the guest/IP rate-limit key (rate-limit.js's
// guestOrIpKey). The current set of callers is not enumerated here because
// that list has gone stale in review three times running -- to find it,
// grep the repo for `csrfHeader()` (src/public/js/*.js and src/views/**/*.ejs).
//
// Reads the meta tag FRESH on every call rather than caching it at load time:
// this file is loaded once per page (partials/head.ejs, non-deferred, ahead
// of every other script: issue #1021 hoisted the <script> tag here from
// footer.ejs so this file, and client-error.js loaded right beside it, run
// before any of the page's own scripts can throw at parse time), but nothing
// about it depends on the DOM being ready, since the read only happens
// inside the functions below, at whatever later moment a write actually
// fires.
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
