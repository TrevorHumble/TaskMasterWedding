// src/public/js/gallery.js
// Live person search for the gallery's By-person view (issue #251): as the
// guest types in #person-search, sections whose guest name doesn't match are
// hidden client-side — no fetch, no page reload. Matching is the app's one
// name-filter rule, HuntFilter.nameMatchesQuery in /js/filter.js
// (case-insensitive, any-word prefix: "pri" matches "Priya Patel"), so the
// admin guest search and this filter can never drift apart. The form this
// input lives in still submits ?q= server-side — that is the no-JS fallback.
'use strict';

/**
 * Apply a name query to a list of person sections, toggling each one's
 * `hidden` property. Pure over its inputs (sections just need
 * getAttribute + a hidden property, so tests can pass plain objects), with
 * the match rule injected rather than reached for globally.
 *
 * @param {ArrayLike<{getAttribute: Function, hidden: boolean}>} sections
 *        elements carrying data-person-section="<guest name>"
 * @param {string} query what the guest typed; blank shows everything
 * @param {(name: string, query: string) => boolean} matches the name-filter rule
 * @returns {number} how many sections remain visible
 */
function applyPersonFilter(sections, query, matches) {
  var shown = 0;
  for (var i = 0; i < sections.length; i++) {
    var visible = matches(sections[i].getAttribute('data-person-section'), query);
    sections[i].hidden = !visible;
    if (visible) {
      shown++;
    }
  }
  return shown;
}

function wireUpPersonSearch() {
  var input = document.getElementById('person-search');
  if (!input || !window.HuntFilter) {
    return;
  }
  var sections = document.querySelectorAll('[data-person-section]');
  input.addEventListener('input', function () {
    applyPersonFilter(sections, input.value, window.HuntFilter.nameMatchesQuery);
  });
}

if (typeof window !== 'undefined') {
  // The script tag is deferred, so the DOM is normally parsed by the time
  // this runs — wire immediately; fall back to DOMContentLoaded only when
  // still loading (covers a non-deferred include).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUpPersonSearch);
  } else {
    wireUpPersonSearch();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    applyPersonFilter: applyPersonFilter,
    wireUpPersonSearch: wireUpPersonSearch,
  };
}
