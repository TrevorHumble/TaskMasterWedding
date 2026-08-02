// src/public/js/filter.js
// The one name filter rule for the guest-facing gallery search (client and
// server) plus the admin guests search: case-insensitive, any-word prefix
// match. "ava" matches "Ava Fenwick" and "Marigold Avalon"; "fen" matches
// "Ava Fenwick"; "av fe" matches only names where BOTH query words
// prefix-match some name word. Pure function, no DOM — client pages wire it
// up themselves (admin.js does for the guests search, gallery.js for the
// live gallery search), and src/services/feed.js requires this same module
// for the server-side ?q= no-JS fallback (issue #935), so those surfaces
// apply one rule from one place. The module.exports guard below is what
// makes it requireable both in the browser (window.HuntFilter) and in Node.
//
// NOT covered: the admin Photos grouped search (src/routes/admin/moderation.js)
// still applies its own separate substring-match rule and does not consume
// this module — a known divergence, tracked as issue #1044 rather than
// folded into this one's Touches.
'use strict';

/**
 * @param {string|null|undefined} name  the guest's display name
 * @param {string|null|undefined} query what the admin typed
 * @returns {boolean} true when every whitespace-separated query word is a
 *          prefix of at least one word of the name. Blank query matches all.
 */
function nameMatchesQuery(name, query) {
  var q = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (q === '') {
    return true;
  }
  var nameWords = (typeof name === 'string' ? name : '')
    .toLowerCase()
    .split(/\s+/)
    .filter(function (w) {
      return w.length > 0;
    });
  var queryWords = q.split(/\s+/);
  return queryWords.every(function (qw) {
    return nameWords.some(function (nw) {
      return nw.indexOf(qw) === 0;
    });
  });
}

if (typeof window !== 'undefined') {
  window.HuntFilter = { nameMatchesQuery: nameMatchesQuery };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { nameMatchesQuery: nameMatchesQuery };
}
