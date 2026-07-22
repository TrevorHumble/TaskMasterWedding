// src/public/js/recap.js
// Issue #644 — the recap ("what you missed") panel. Both phase-1 inline
// scripts (header.ejs's panel/strip wiring, guest-home.ejs's profile-row
// opener) live here now, generalized from disposable sample data to the
// real thing:
//   - Open the panel from EITHER entry point (#recap-open the strip,
//     #recap-open-profile the permanent profile row) and fire
//     POST /recap/seen the instant it opens — the single trigger that
//     advances the guest's recap checkpoint (design: only opening marks
//     read; dismissing never does).
//   - Dismiss (#recap-dismiss) removes the strip band for this page load
//     only — no server call, so the unread count/strip survive a reload.
//   - Scroll paging: GET /recap?before=<cursor>&beforeKey=<cursorKey>
//     appends older rows as the guest nears the bottom of the list. Both
//     params travel together (issue #644 review) — `before` alone cannot
//     tell two rows sharing the same whole-second timestamp apart, silently
//     dropping or re-serving one of them at the page boundary.
//   - Reset-on-close: closing the panel discards every paged-in row, so the
//     next open starts at page one, scrolled to top.
//   - Badge replay: tapping a badge-kind row populates the SHARED
//     #badge-dialog from that row's own data-badge-* attributes and shows
//     it — no navigation, and it works whether or not the badge is still
//     "owed" (celebrated_at may already be non-NULL).
'use strict';

(function () {
  if (typeof document === 'undefined') {
    return;
  }

  var panel = document.getElementById('recap-panel');
  var strip = document.getElementById('recap-strip');
  var list = document.getElementById('recap-list');
  var foot = document.getElementById('recap-foot');
  var footText = document.getElementById('recap-foot-text');

  // Re-queried at the point of use, not cached once at load (issue #644
  // review): the dialog now always renders for a signed-in guest, so this is
  // no longer strictly load-bearing, but a stale cached reference is exactly
  // the kind of thing a later change to WHEN the dialog renders could
  // silently break again — querying fresh costs nothing here.
  function getBadgeDialog() {
    return document.getElementById('badge-dialog');
  }

  // ------------------------------------------------------------------
  // Badge replay — populate the shared dialog from a recap row's own
  // data-badge-* attributes (rendered by header.ejs's forEach, or built by
  // makeRow() below for a scrolled-in page) and play the same bloom
  // src/public/js/badge-moment.js uses for the auto-open case.
  // ------------------------------------------------------------------
  function openBadgeDialog(button) {
    var badgeDialog = getBadgeDialog();
    if (!badgeDialog) {
      return;
    }
    var name = button.getAttribute('data-badge-name') || '';
    var description = button.getAttribute('data-badge-description') || '';
    var artHtml = button.getAttribute('data-badge-art-html') || '';

    var title = badgeDialog.querySelector('.badge-title');
    var sub = badgeDialog.querySelector('.badge-sub');
    var stage = badgeDialog.querySelector('.badge-sway');
    if (title) {
      title.textContent = name + '!';
    }
    if (sub) {
      sub.textContent = description;
    }
    if (stage) {
      // Server-rendered markup from the SAME shared partials/badge-art.ejs
      // every other badge display uses (src/services/notifications.js's
      // renderBadgeArt, delivered on the row as data-badge-art-html) — not a
      // hand-composed `<img>` (issue #644 review: a plain `<img>` here
      // skipped the medallion-ring treatment a task-icon badge gets
      // everywhere else, contradicting docs/economy-architecture's Rule 5).
      stage.innerHTML = artHtml;
    }

    badgeDialog.classList.remove('playing');
    if (typeof badgeDialog.showModal === 'function' && !badgeDialog.open) {
      badgeDialog.showModal();
    }
    // Force a reflow so the bloom keyframes restart from their 0% frame
    // every replay (same trick badge-moment.js uses for the first, auto-open
    // play).
    void badgeDialog.offsetWidth;
    badgeDialog.classList.add('playing');
  }

  // ------------------------------------------------------------------
  // Open / close / dismiss / badge replay — one delegated listener covers
  // every control, including rows appended later by scroll paging.
  // ------------------------------------------------------------------
  function markSeen() {
    if (!window.fetch) {
      return;
    }
    // Fire-and-forget: the guest is already looking at the panel by the time
    // this resolves or fails, and a failed POST just means the checkpoint
    // does not advance this time — the guest sees the same unread items
    // again next visit rather than losing them, the safer failure mode.
    fetch('/recap/seen', { method: 'POST', credentials: 'same-origin' }).catch(function () {});
  }

  document.addEventListener('click', function (event) {
    var target = event.target;
    if (!target || !target.closest) {
      return;
    }

    if (target.closest('#recap-open, #recap-open-profile')) {
      if (panel && typeof panel.showModal === 'function' && !panel.open) {
        panel.showModal();
      }
      markSeen();
      return;
    }
    if (target.closest('#recap-close')) {
      if (panel) {
        panel.close();
      }
      return;
    }
    if (target.closest('#recap-dismiss')) {
      if (strip) {
        strip.remove();
      }
      return;
    }
    var badgeButton = target.closest('.recap-row-badge button.recap-row-link');
    if (badgeButton) {
      if (panel && panel.open) {
        panel.close();
      }
      openBadgeDialog(badgeButton);
      return;
    }
    var badgeDialog = getBadgeDialog();
    if (badgeDialog && target.closest('#badge-dialog .badge-continue')) {
      badgeDialog.close();
    }
  });

  // The list is display:none while the recap dialog is closed, and a hidden
  // element ignores a scrollTop write — pin it to the top again on the way
  // in, from whichever surface opened it.
  document.addEventListener('click', function (event) {
    var target = event.target;
    if (list && target && target.closest && target.closest('#recap-open, #recap-open-profile')) {
      window.setTimeout(function () {
        list.scrollTop = 0;
      }, 0);
    }
  });

  if (!list || !foot || !footText) {
    // Zero-event state: the panel renders .recap-empty instead of the list
    // (issue #644 AC7) — open/close/dismiss above already cover that case
    // fully, so there is nothing left to wire.
    return;
  }

  // ------------------------------------------------------------------
  // Row markup for a scrolled-in page — mirrors header.ejs's server-rendered
  // forEach body exactly (same classes), needed here only because GET /recap
  // answers JSON, not HTML; the first page is always server-rendered. The
  // glyph markup comes from the row's own `glyph` field (delivered by GET
  // /recap, built once by src/services/notifications.js) rather than a
  // second copy of the per-kind SVGs hard-coded here — a hard-coded constant
  // in this file is exactly what let this file's glyph silently diverge from
  // header.ejs's server-rendered one in the first place (issue #644 review).
  // ------------------------------------------------------------------
  var CHEVRON_SVG =
    '<svg viewBox="0 0 24 24" focusable="false"><path d="m9 5 7 7-7 7" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function makeRow(row) {
    var li = document.createElement('li');
    li.className = 'recap-row recap-row-' + row.kind + (row.unread ? ' recap-row-unread' : '');

    var inner;
    if (row.dead) {
      inner = document.createElement('span');
      inner.className = 'recap-row-link recap-row-inert';
    } else if (row.href) {
      inner = document.createElement('a');
      inner.className = 'recap-row-link';
      inner.setAttribute('href', row.href);
    } else {
      inner = document.createElement('button');
      inner.type = 'button';
      inner.className = 'recap-row-link';
      if (row.badge) {
        inner.setAttribute('data-badge-code', row.badge.code);
        inner.setAttribute('data-badge-name', row.badge.name);
        inner.setAttribute('data-badge-art', row.badge.art_path);
        inner.setAttribute('data-badge-description', row.badge.description);
        inner.setAttribute('data-badge-art-html', row.badgeArtHtml || '');
      }
    }

    if (row.thumb) {
      var img = document.createElement('img');
      img.className = 'recap-thumb';
      img.src = '/thumbs/' + row.thumb;
      img.alt = '';
      inner.appendChild(img);
    } else {
      var icon = document.createElement('span');
      icon.className = 'recap-icon recap-icon-' + row.kind;
      icon.innerHTML = row.glyph;
      inner.appendChild(icon);
    }

    var body = document.createElement('span');
    body.className = 'recap-row-body';
    var text = document.createElement('span');
    text.className = 'recap-row-text';
    // Each part is applied via textContent/createTextNode, never innerHTML —
    // escaping by construction (issue #644 review), mirroring header.ejs's
    // own `<%= %>`-per-part render. `quote` wraps the segment in curly
    // quotes without touching its escaping.
    (row.parts || []).forEach(function (part) {
      var node;
      if (part.emphasis) {
        node = document.createElement('strong');
        node.textContent = part.text;
        text.appendChild(node);
      } else if (part.quote) {
        text.appendChild(document.createTextNode('“' + part.text + '”'));
      } else {
        text.appendChild(document.createTextNode(part.text));
      }
    });
    var when = document.createElement('span');
    when.className = 'recap-row-when';
    when.textContent = row.whenLabel;
    body.appendChild(text);
    body.appendChild(when);
    inner.appendChild(body);

    if (!row.dead) {
      var chevron = document.createElement('span');
      chevron.className = 'recap-row-chevron';
      chevron.setAttribute('aria-hidden', 'true');
      chevron.innerHTML = CHEVRON_SVG;
      inner.appendChild(chevron);
    }

    li.appendChild(inner);
    return li;
  }

  // ------------------------------------------------------------------
  // Scroll paging (issue #644 AC6). cursor/cursorKey are the oldest loaded
  // row's `when`/`key` (the same composite pair GET /recap's ?before=/
  // ?beforeKey= compares against server-side — src/services/notifications.js
  // orders and filters by the identical (when, key) tuple), so paging always
  // walks strictly older with no gap or overlap, even when two rows share a
  // whole-second timestamp.
  // ------------------------------------------------------------------
  var INITIAL_CURSOR = foot.getAttribute('data-cursor') || '';
  var INITIAL_CURSOR_KEY = foot.getAttribute('data-cursor-key') || '';
  var INITIAL_HAS_MORE = foot.getAttribute('data-has-more') === '1';
  var cursor = INITIAL_CURSOR;
  var cursorKey = INITIAL_CURSOR_KEY;
  var hasMore = INITIAL_HAS_MORE;
  var busy = false;

  function loadMore() {
    if (busy || !hasMore || !cursor || !window.fetch) {
      return;
    }
    busy = true;
    footText.textContent = 'Loading older…';
    fetch(
      '/recap?before=' + encodeURIComponent(cursor) + '&beforeKey=' + encodeURIComponent(cursorKey),
      { credentials: 'same-origin' }
    )
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        busy = false;
        if (!data) {
          footText.innerHTML = hasMore ? '&nbsp;' : 'That&rsquo;s everything.';
          return;
        }
        var frag = document.createDocumentFragment();
        data.rows.forEach(function (row) {
          frag.appendChild(makeRow(row));
          cursor = row.when;
          cursorKey = row.key;
        });
        // Insert ABOVE the foot so the foot never jumps position, and the
        // list's own height never changes — only its scrollable content.
        list.insertBefore(frag, foot);
        hasMore = data.hasMore;
        footText.innerHTML = hasMore ? '&nbsp;' : 'That&rsquo;s everything.';
      })
      .catch(function () {
        busy = false;
        footText.innerHTML = hasMore ? '&nbsp;' : 'That&rsquo;s everything.';
      });
  }

  // Prefetch a screenful early so rows are already in place by the time the
  // bottom is reached — the scroll never stalls waiting on a batch.
  list.addEventListener('scroll', function () {
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 600) {
      loadMore();
    }
  });

  // ------------------------------------------------------------------
  // Reset-on-close: closing the panel discards everything paged in, so the
  // next open starts from the first (server-rendered) page again, at the
  // top (issue #644 AC6).
  // ------------------------------------------------------------------
  var FIRST_PAGE_COUNT = list.querySelectorAll('.recap-row').length;

  function reset() {
    var rows = list.querySelectorAll('.recap-row');
    for (var i = rows.length - 1; i >= FIRST_PAGE_COUNT; i--) {
      rows[i].remove();
    }
    cursor = INITIAL_CURSOR;
    cursorKey = INITIAL_CURSOR_KEY;
    hasMore = INITIAL_HAS_MORE;
    busy = false;
    footText.innerHTML = hasMore ? '&nbsp;' : 'That&rsquo;s everything.';
    list.scrollTop = 0;
  }

  if (panel) {
    panel.addEventListener('close', reset);
  }
})();
