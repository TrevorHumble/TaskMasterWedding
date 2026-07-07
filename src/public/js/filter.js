// src/public/js/filter.js
// The one client-side name filter: case-insensitive, any-word prefix match.
// "ava" matches "Ava Fenwick" and "Marigold Avalon"; "fen" matches "Ava
// Fenwick"; "av fe" matches only names where BOTH query words prefix-match
// some name word. Pure function, no DOM — pages wire it up themselves
// (admin.js does for the guests search). Requireable in tests via the
// module.exports guard, same pattern as upload-filename.js.
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
