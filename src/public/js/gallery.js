// src/public/js/gallery.js
// Live search for the gallery's two grouped views: By-person (issue #251) and
// By-task (issue #527). As the guest types, sections whose heading doesn't
// match are hidden client-side — no fetch, no page reload. Both views run the
// SAME wiring, parameterized by input id and section attribute, so they can
// never drift into two behaviors behind one control again.
//
// Matching is the app's one client-side filter rule,
// HuntFilter.nameMatchesQuery in /js/filter.js (case-insensitive, any-word
// prefix: "pri" matches "Priya Patel", "dessert" matches "Photograph the
// dessert table"), shared with the admin guest search. The form each input
// lives in still submits ?q= server-side — that is the no-JS fallback, owned
// by feed.grouped() in src/services/feed.js, and it is a SUBSTRING match: a
// different rule from this one, and neither is strictly broader. "av fe"
// matches live but not server-side; "ess" matches server-side but not live.
'use strict';

// The two grouped views, as (input id, section attribute) pairs — the single
// place this file learns which views are searchable. A third grouped view
// needs a row here AND three edits in src/views/gallery.ejs: the input id,
// the section's data-* attribute, and the script-include condition. What this
// table buys is that none of those is a second FILTER implementation.
var SEARCHABLE_VIEWS = [
  { inputId: 'person-search', attribute: 'data-person-section' },
  { inputId: 'task-search', attribute: 'data-task-section' },
];

/**
 * Apply a query to a list of sections, toggling each one's `hidden` property.
 * Pure over its inputs (sections just need getAttribute + a hidden property,
 * so tests can pass plain objects), with the match rule injected rather than
 * reached for globally.
 *
 * @param {ArrayLike<{getAttribute: Function, hidden: boolean}>} sections
 *        elements carrying `attribute`="<the section's heading>"
 * @param {string} query what the guest typed; blank shows everything
 * @param {(name: string, query: string) => boolean} matches the filter rule
 * @param {string} attribute which data-* attribute holds the heading
 * @returns {number} how many sections remain visible
 */
function applySectionFilter(sections, query, matches, attribute) {
  var shown = 0;
  for (var i = 0; i < sections.length; i++) {
    var visible = matches(sections[i].getAttribute(attribute), query);
    sections[i].hidden = !visible;
    if (visible) {
      shown++;
    }
  }
  return shown;
}

/**
 * Wire one view's search input to its own sections. A no-op when the input
 * isn't on this page — which is what lets the caller wire every view
 * unconditionally instead of branching on which view rendered.
 *
 * @param {string} inputId id of the search input
 * @param {string} attribute the data-* attribute marking that view's sections
 */
function wireUpSectionSearch(inputId, attribute) {
  var input = document.getElementById(inputId);
  if (!input || !window.HuntFilter) {
    return;
  }
  var sections = document.querySelectorAll('[' + attribute + ']');
  input.addEventListener('input', function () {
    applySectionFilter(sections, input.value, window.HuntFilter.nameMatchesQuery, attribute);
  });
}

/**
 * Wire every searchable view. Safe to call on any gallery page: each pair is
 * a no-op unless that view's input is actually on the page, so this needs no
 * knowledge of which view rendered. This is the entry point the browser runs
 * — tests should call it rather than wireUpSectionSearch directly, or a typo
 * in SEARCHABLE_VIEWS goes unseen.
 */
function wireUpGallerySearch() {
  for (var i = 0; i < SEARCHABLE_VIEWS.length; i++) {
    wireUpSectionSearch(SEARCHABLE_VIEWS[i].inputId, SEARCHABLE_VIEWS[i].attribute);
  }
}

if (typeof window !== 'undefined') {
  // The script tag is deferred, so the DOM is normally parsed by the time
  // this runs — wire immediately; fall back to DOMContentLoaded only when
  // still loading (covers a non-deferred include).
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUpGallerySearch);
  } else {
    wireUpGallerySearch();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    applySectionFilter: applySectionFilter,
    wireUpSectionSearch: wireUpSectionSearch,
    wireUpGallerySearch: wireUpGallerySearch,
  };
}
