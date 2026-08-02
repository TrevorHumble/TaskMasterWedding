// src/public/js/gallery-more.js
// Infinite-scroll "Show more" for the gallery's Recent view (issue #610):
// activating the control fetches the next server-rendered page, lifts its
// grid tiles into the current grid, and advances (or removes) the control —
// one continuous wall, scroll position untouched. Progressive enhancement
// over the existing paged endpoint: the control stays a plain <a> to
// ?view=recent&page=N+1, so with JavaScript off (or on any fetch/parse
// failure) it degrades to today's full-page navigation.
'use strict';

// How many pages the live grid may hold before "Show more" hands off to a
// real navigation instead of appending — the server-rendered first page plus
// four appends (#1056). The measurement behind the number, and what
// re-deciding it requires, is in DESIGN.md § "Show more's page bound is a
// client-side append budget, not a server-side cap (#1056)".
var MAX_PAGES_IN_GRID = 5;

/**
 * Lift the next page's tiles out of a parsed gallery document and into the
 * live grid, and report where the control should point next.
 *
 * @param {Document} doc parsed HTML of the next gallery page
 * @param {Element} grid the live #galleryGrid to append tiles into
 * @returns {{ appended: number, nextHref: string|null }}
 *          appended: how many tiles were moved;
 *          nextHref: the following page's href, or null when this was the
 *          last page (caller removes the control).
 * @throws {Error} when the fetched document has no #galleryGrid — the
 *         response was not a gallery page (caller falls back to navigation).
 */
function appendNextPage(doc, grid) {
  var nextGrid = doc.getElementById('galleryGrid');
  if (!nextGrid) {
    throw new Error('fetched page has no gallery grid');
  }
  var appended = 0;
  while (nextGrid.firstChild) {
    // appendChild adopts the node across documents, so the tiles keep their
    // markup (lazy-loading thumbs, like badges) without re-parsing.
    grid.appendChild(nextGrid.firstChild);
    appended++;
  }
  var nextLink = doc.querySelector('.show-more a');
  return { appended: appended, nextHref: nextLink ? nextLink.getAttribute('href') : null };
}

function wireUpShowMore() {
  var nav = document.querySelector('.show-more');
  var grid = document.getElementById('galleryGrid');
  if (!nav || !grid) {
    return;
  }
  var link = nav.querySelector('a');
  if (!link) {
    return;
  }

  var idleLabel = link.textContent;
  // Per-wiring closure, not module state: a fresh page load re-runs
  // wireUpShowMore, so the budget restarts for the new page for free (#1056
  // AC4). The server-rendered first page already counts as one.
  var pagesInGrid = 1;

  link.addEventListener('click', function (event) {
    if (link.getAttribute('aria-disabled') === 'true') {
      event.preventDefault();
      return; // a fetch is already in flight; ignore repeat taps
    }
    if (pagesInGrid >= MAX_PAGES_IN_GRID) {
      // At the threshold: do not intercept. The anchor's own navigation
      // fires, which is already the module's documented fallback path and
      // hands off to a fresh, unaccumulated page (#1056 AC2).
      return;
    }
    event.preventDefault();
    link.setAttribute('aria-disabled', 'true');
    link.textContent = 'Loading…';

    fetch(link.getAttribute('href'), { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        var result = appendNextPage(doc, grid);
        pagesInGrid++;
        if (result.nextHref) {
          link.setAttribute('href', result.nextHref);
          link.textContent = idleLabel;
          link.removeAttribute('aria-disabled');
        } else {
          nav.remove();
        }
      })
      .catch(function () {
        // Any failure — network, non-200, unexpected markup — falls back to
        // the link's normal behavior: a full navigation to the next page.
        window.location.href = link.getAttribute('href');
      });
  });
}

if (typeof window !== 'undefined') {
  // Deferred script: the DOM is normally parsed by the time this runs — wire
  // immediately; fall back to DOMContentLoaded only when still loading.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUpShowMore);
  } else {
    wireUpShowMore();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    appendNextPage: appendNextPage,
    wireUpShowMore: wireUpShowMore,
    MAX_PAGES_IN_GRID: MAX_PAGES_IN_GRID,
  };
}
