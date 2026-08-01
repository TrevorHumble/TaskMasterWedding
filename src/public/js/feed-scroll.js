// src/public/js/feed-scroll.js
// Bidirectional in-place loading for the full-screen /feed (issue #677):
// scrolling near the bottom fetches the next-older window and appends it;
// scrolling near the top fetches the next-newer window and prepends it,
// restoring the scroll offset so the photo the guest was viewing stays put.
// Sibling of gallery-more.js (#610): progressive enhancement over the
// existing paged endpoint — the "Newer"/"Older" pager links stay plain <a>s
// to /feed?from=N, so with JavaScript off the feed degrades to today's
// full-page navigation. Unlike #610, a fetch failure here never navigates:
// every trigger is scroll-driven, not an explicit tap, so falling back to a
// full navigation would yank the guest off the photo they were viewing
// because a background prefetch they didn't ask for failed (AC5). Failures
// are swallowed and the edge stays armed for a retry on the next scroll.
// The venue-wifi bound (#194) is untouched: every fetch is still one
// FEED_PAGE_SIZE window.
// Scroll-anchoring toggle (#677 PR review): document.body carries
// .feed-inserting only while at least one insert holds it (hold taken just
// before the DOM mutation in load() below, released two animation frames
// later; a counter, so overlapping inserts from the two edges never strip
// the class out from under each other) — see guest.css's body.feed-inserting
// rule for why this is a toggle rather than a static suppression, and
// prependNewer's own doc comment for how the two mechanisms divide the work.
'use strict';

/**
 * Lift the feed tiles out of a parsed /feed document, skipping any photo
 * already present in the live feed (the first page overlaps the current
 * window when fewer than a full window of newer photos exist).
 *
 * @param {Document} doc parsed HTML of the fetched /feed page
 * @param {Element} feedEl the live .feed container
 * @returns {{ items: Element[], newerHref: string|null, olderHref: string|null }}
 *          items: the fetched .feed-item nodes not already in the live feed,
 *          in document (newest-first) order; newerHref/olderHref: where the
 *          fetched page's own pager controls point, or null when absent.
 * @throws {Error} when the fetched document has no .feed — the response was
 *         not a feed page (the caller's catch treats it like any failed
 *         fetch: give up quietly, stay retryable).
 */
function liftFeedItems(doc, feedEl) {
  var nextFeed = doc.querySelector('.feed');
  if (!nextFeed) {
    throw new Error('fetched page has no feed');
  }
  var existing = {};
  var liveItems = feedEl.querySelectorAll('.feed-item[id]');
  for (var i = 0; i < liveItems.length; i++) {
    existing[liveItems[i].id] = true;
  }
  var items = [];
  var fetched = nextFeed.querySelectorAll('.feed-item');
  for (var j = 0; j < fetched.length; j++) {
    if (!fetched[j].id || !existing[fetched[j].id]) {
      items.push(fetched[j]);
    }
  }
  var newerLink = doc.querySelector('.pagination .page-link-newer');
  var olderLink = doc.querySelector('.pagination .page-link-older');
  return {
    items: items,
    newerHref: newerLink ? newerLink.getAttribute('href') : null,
    olderHref: olderLink ? olderLink.getAttribute('href') : null,
  };
}

/**
 * Append a fetched next-older window below the live feed.
 *
 * @returns {{ inserted: number, nextHref: string|null }} nextHref: the
 *          following older page, or null when this was the last one.
 */
function appendOlder(doc, feedEl) {
  var lifted = liftFeedItems(doc, feedEl);
  for (var i = 0; i < lifted.items.length; i++) {
    // appendChild adopts the node across documents, so tiles keep their
    // markup (lightbox hooks, dialogs, lazy thumbs) without re-parsing.
    feedEl.appendChild(lifted.items[i]);
  }
  return { inserted: lifted.items.length, nextHref: lifted.olderHref };
}

/**
 * Prepend a fetched next-newer window above the live feed WITHOUT the page
 * jumping: the first live tile's viewport position is measured before and
 * after the insert and the scroll is adjusted by the difference, so the
 * photo the guest was viewing stays in the same visual position. This
 * measure-and-adjust is the single owner of the correction FOR THE INSERT
 * TICK ITSELF — the caller (load(), below) suppresses native CSS scroll
 * anchoring for exactly that tick via document.body.feed-inserting, so the
 * two mechanisms never stack and double-correct. Native anchoring is back on
 * the instant the tick ends, and stays the one to compensate for anything
 * that resizes LATER (e.g. a lazily-resolving image height above the
 * viewport) — see guest.css's body.feed-inserting rule for the full
 * division of labor.
 *
 * @param {Function} [scrollBy] scroll-adjust hook, defaults to
 *        window.scrollBy — injectable so tests can observe the correction.
 * @returns {{ inserted: number, nextHref: string|null }} nextHref: the
 *          following newer page, or null when the newest photo is loaded.
 */
function prependNewer(doc, feedEl, scrollBy) {
  var adjust =
    scrollBy ||
    function (x, y) {
      window.scrollBy(x, y);
    };
  var lifted = liftFeedItems(doc, feedEl);
  var anchor = feedEl.firstElementChild;
  var before = anchor ? anchor.getBoundingClientRect().top : 0;
  for (var i = 0; i < lifted.items.length; i++) {
    feedEl.insertBefore(lifted.items[i], anchor);
  }
  if (anchor && lifted.items.length > 0) {
    adjust(0, anchor.getBoundingClientRect().top - before);
  }
  return { inserted: lifted.items.length, nextHref: lifted.newerHref };
}

function wireUpFeedScroll() {
  var feedEl = document.querySelector('.feed');
  var nav = document.querySelector('.pagination');
  if (!feedEl || !nav) {
    return;
  }
  if (
    typeof window.IntersectionObserver !== 'function' ||
    typeof window.fetch !== 'function' ||
    typeof window.DOMParser !== 'function'
  ) {
    return; // leave the pager links doing full navigations
  }

  var newerLink = nav.querySelector('.page-link-newer');
  var olderLink = nav.querySelector('.page-link-older');
  var edges = {
    newer: {
      href: newerLink ? newerLink.getAttribute('href') : null,
      sentinel: document.getElementById('feedSentinelNewer'),
      indicator: document.getElementById('feedEdgeNewer'),
      insert: prependNewer,
      inFlight: false,
    },
    older: {
      href: olderLink ? olderLink.getAttribute('href') : null,
      sentinel: document.getElementById('feedSentinelOlder'),
      indicator: document.getElementById('feedEdgeOlder'),
      insert: appendOlder,
      inFlight: false,
    },
  };

  // The pager is the no-JS fallback; once auto-load is wired the links are
  // redundant and the feed reads as one continuous surface.
  nav.hidden = true;

  function retire(edge) {
    edge.href = null;
    if (edge.sentinel) {
      observer.unobserve(edge.sentinel);
    }
    if (edge.indicator) {
      edge.indicator.hidden = true;
    }
  }

  // Suppress native CSS scroll anchoring for exactly the ticks that process
  // an insert: each in-flight insert takes a hold; the body class stays on
  // while ANY hold is open and comes off when the last one releases. A plain
  // add/remove pair instead of this counter has a one-frame race the per-edge
  // guards make reachable: a second insert landing after the first insert's
  // delayed removal was queued would have its layout pass run with anchoring
  // already restored — the exact double-correct/stall this class exists to
  // prevent. Release is delayed two animation frames — one for the browser's
  // own layout pass over the inserted nodes, a second so anchoring is live
  // again before the next scroll/observer tick — with a synchronous fallback
  // when requestAnimationFrame is unavailable (e.g. under jsdom in tests).
  var insertHolds = 0;
  function takeInsertHold() {
    insertHolds++;
    document.body.classList.add('feed-inserting');
  }
  function releaseInsertHold() {
    if (insertHolds > 0) {
      insertHolds--;
    }
    if (insertHolds === 0) {
      document.body.classList.remove('feed-inserting');
    }
  }
  function releaseInsertHoldSoon() {
    if (typeof window.requestAnimationFrame === 'function') {
      window.requestAnimationFrame(function () {
        window.requestAnimationFrame(releaseInsertHold);
      });
    } else {
      releaseInsertHold();
    }
  }

  function load(edge) {
    if (edge.inFlight || !edge.href) {
      return;
    }
    edge.inFlight = true;
    var href = edge.href;
    if (edge.indicator) {
      edge.indicator.hidden = false;
    }
    window
      .fetch(href, { credentials: 'same-origin' })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('HTTP ' + res.status);
        }
        return res.text();
      })
      .then(function (html) {
        var doc = new DOMParser().parseFromString(html, 'text/html');
        takeInsertHold();
        var result;
        try {
          result = edge.insert(doc, feedEl);
        } catch (e) {
          // Nothing was inserted — release this load's own hold right away
          // (a concurrent edge's open hold keeps the class on) and fall
          // through to the shared failure arm below.
          releaseInsertHold();
          throw e;
        }
        releaseInsertHoldSoon();
        if (edge.indicator) {
          edge.indicator.hidden = true;
        }
        if (result.nextHref) {
          edge.href = result.nextHref;
        } else {
          retire(edge);
        }
        edge.inFlight = false;
      })
      .catch(function () {
        // Any failure — network, non-200, unexpected markup — gives up
        // quietly: hide the ring, clear this edge's own guard (a fetch at
        // the OTHER edge is unaffected either way), keep edge.href so the
        // next intersection retries. Navigating here would throw the guest
        // off their photo over a background fetch they never asked for.
        // No hold handling here: the only path that took one (edge.insert
        // throwing) already released it before re-throwing above.
        if (edge.indicator) {
          edge.indicator.hidden = true;
        }
        edge.inFlight = false;
      });
  }

  var observer = new window.IntersectionObserver(
    function (entries) {
      for (var i = 0; i < entries.length; i++) {
        if (!entries[i].isIntersecting) {
          continue;
        }
        if (edges.newer.sentinel && entries[i].target === edges.newer.sentinel) {
          load(edges.newer);
        } else if (edges.older.sentinel && entries[i].target === edges.older.sentinel) {
          load(edges.older);
        }
      }
    },
    // Start fetching a window before the guest actually hits the edge, so
    // on a normal connection the next photos are there by the time they are.
    { rootMargin: '600px 0px 600px 0px' }
  );

  if (edges.newer.href && edges.newer.sentinel) {
    observer.observe(edges.newer.sentinel);
  }
  if (edges.older.href && edges.older.sentinel) {
    observer.observe(edges.older.sentinel);
  }
}

if (typeof window !== 'undefined') {
  // Deferred script: the DOM is normally parsed by the time this runs — wire
  // immediately; fall back to DOMContentLoaded only when still loading.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wireUpFeedScroll);
  } else {
    wireUpFeedScroll();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    liftFeedItems: liftFeedItems,
    appendOlder: appendOlder,
    prependNewer: prependNewer,
    wireUpFeedScroll: wireUpFeedScroll,
  };
}
