// src/public/js/client-error.js
// Issue #1021: the browser-side crash beacon. Loaded NON-DEFERRED from
// partials/head.ejs, immediately after csrf.js and before every stylesheet
// link, so window.onerror/unhandledrejection are registered before any other
// script on the page (including this page's own <head> scripts) can throw at
// parse time. A deferred load would run after every non-deferred script,
// missing exactly the top-level crash it exists to catch.
//
// Fire-and-forget POST /client-error with window.csrfHeader(): same
// fetch(...).catch(function(){}) precedent as recap.js's markSeen: a failed
// beacon POST costs nothing but one missed log line, never a guest-visible
// error.
//
// Server-side truncation (src/routes/guest/client-error.js) is authoritative;
// the truncation here is a courtesy to keep the POST body small, not a
// security boundary.
'use strict';

(function () {
  if (typeof window === 'undefined') {
    return;
  }

  // Client-side flood guard (issue #1021 design): at most MAX_REPORTS beacons
  // per page load, and no closer together than MIN_INTERVAL_MS: a page stuck
  // in a tight error loop (e.g. a script re-throwing on every animation
  // frame) must not flood the network or the server-side rate limiter with a
  // single guest's own retries.
  var MAX_REPORTS = 5;
  var MIN_INTERVAL_MS = 10000;
  var MESSAGE_MAX = 500;
  var STACK_MAX = 2000;

  var reportCount = 0;
  var lastReportAt = 0;
  var reporting = false; // Defensive only; MAX_REPORTS/MIN_INTERVAL_MS close the real loop. Rationale and jsdom probe: DESIGN.md § "Client-error beacon".

  function report(message, stack) {
    if (reporting) {
      return;
    }
    var now = Date.now();
    if (reportCount >= MAX_REPORTS || now - lastReportAt < MIN_INTERVAL_MS) {
      return;
    }
    if (!window.fetch) {
      return;
    }

    reporting = true;
    try {
      reportCount += 1;
      lastReportAt = now;

      var body = {
        message: String(message || '').slice(0, MESSAGE_MAX),
        stack: String(stack || '').slice(0, STACK_MAX),
        url: window.location ? window.location.href : '',
      };

      var headers = window.csrfHeader ? window.csrfHeader() : {};
      headers['Content-Type'] = 'application/json';

      window
        .fetch('/client-error', {
          method: 'POST',
          credentials: 'same-origin',
          headers: headers,
          body: JSON.stringify(body),
        })
        .catch(function () {});
    } finally {
      reporting = false;
    }
  }

  window.addEventListener('error', function (event) {
    // A plain resource-load failure (a missing image/script) also fires
    // 'error' on window, but carries no `error` object and no useful
    // message/stack, nothing this beacon exists to catch. Only a real
    // uncaught JS exception reaches here with event.message set.
    if (!event || !event.message) {
      return;
    }
    var stack = event.error && event.error.stack ? event.error.stack : '';
    report(event.message, stack);
  });

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event && event.reason;
    var message;
    var stack = '';
    if (reason instanceof Error) {
      message = reason.message;
      stack = reason.stack || '';
    } else {
      message = String(reason);
    }
    report(message, stack);
  });
})();
