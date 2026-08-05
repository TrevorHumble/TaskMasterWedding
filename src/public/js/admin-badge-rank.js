// src/public/js/admin-badge-rank.js
//
// Issue #661 — drives the "Rank & award" page (src/views/admin-badge-rank.ejs,
// GET/POST /admin/tasks/:id/rank). Transcribed from the owner-approved
// phase-1 mock (src/public/mock-rank.html, deleted) — the winner-picking
// grid and the drag-to-reorder technique are carried over verbatim (pointer
// events, setPointerCapture, the grabbed row lifts+follows via transform,
// displaced rows glide via a First-Last-Invert-Play transition — the SAME
// technique as the admin task-card reorder, src/public/js/admin-tasks.js).
//
// Real difference from both the mock and admin-tasks.js's own drag: this
// page has NO persistence endpoint to POST to on each drop — picking and
// reordering only mutate in-page state until the host hits Release, which is
// a single real form submit (src/views/admin-badge-rank.ejs's
// #rankReleaseForm), not a fetch.
//
// Real difference from the mock: the mock's `released` was a one-way demo
// flag (togglePick simply refused once true). The real page must let a
// released (Awarded) task be RE-RANKED (issue #661 AC6). Issue #892 (owner
// direction 2026-07-28) redesigned HOW: a released task opens as a RESULTS
// view — the pick grid is gone entirely, the winner rows carry no drag
// handles, and the one way back into editing is the explicit Edit-ranking
// button. (The prior behavior — any pick-tile tap silently re-entering edit
// mode AND toggling that tile — is what let a host mis-tap their released
// ranking apart with no visual cue.) In edit mode the Release button appears
// only once the ranking actually DIFFERS from the released one, so an
// unchanged ranking has nothing to re-release and nothing to re-notify
// (#889's server dedupe is the belt to this suspender).
(function () {
  'use strict';
  if (typeof document === 'undefined') return;

  var app = document.getElementById('rank-app');
  if (!app) return;

  var MAX = parseInt(app.getAttribute('data-max-winners'), 10) || 3;

  /**
   * Escape a GUEST-CONTROLLED string (a display name — the only freeform,
   * attacker-influenceable text this page ever renders; every other value it
   * builds into markup is a number this page itself generated, a task/badge
   * field already escaped server-side by EJS, or a system-generated filename
   * matching photos.js's own strict storage allowlist, never freeform guest
   * input) so it is always safe to drop into BOTH an HTML text node and a
   * double-quoted HTML attribute value built by string concatenation. This
   * app sets no CSP, so an unescaped guest name reaching innerHTML/an
   * interpolated attribute here would execute in the host's authenticated
   * admin session the moment they open this page — see this file's render
   * functions below for the three sinks a guest's own display name reaches
   * (the pick-tile's img alt, the drag handle's aria-label, and the ranked
   * row's name span).
   * @param {*} value
   * @returns {string}
   */
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function parseJsonAttr(name) {
    var raw = app.getAttribute(name);
    if (!raw) return [];
    try {
      var parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  // Points paid by placement, 1st..3rd (issue #1106) — read from the
  // server's OWN src/services/task-badges.js POINTS_BY_RANK (issue #661 PR
  // review: a hand-synced client literal is a second, driftable owner of
  // this mapping). This copy still decides nothing on its own: the POST
  // below carries only an ORDER of submission ids, and the server
  // re-derives points from position on write regardless of what this array
  // holds — but it is now the SAME array, serialized down, not a second one
  // kept in sync by hand. Falls back to the one true default only if the
  // attribute is somehow missing/unparseable, so a broken attribute degrades
  // to the correct real-world value rather than an arbitrary guess.
  var POINTS = parseJsonAttr('data-points-by-rank');
  if (!POINTS.length) POINTS = [5, 3, 2];

  var PHOTOS = parseJsonAttr('data-photos'); // [{ id, thumb_path, photo_path, guest_id, guest_name }]
  var WINNERS = parseJsonAttr('data-winners'); // [{ rank, points, submission_id, guest_id, guest_name, thumb_path }]

  // byId merges BOTH sources: a photo still visible today (PHOTOS) and a
  // past winner whose photo may since have been taken down (AC4 — the award
  // survives even though the pick grid no longer offers it). Winners are
  // folded in first so a currently-visible PHOTOS entry (fresher — it always
  // reflects the CURRENT thumb/guest) overwrites it, never the reverse.
  var byId = {};
  WINNERS.forEach(function (w) {
    byId[w.submission_id] = { id: w.submission_id, name: w.guest_name, thumb: w.thumb_path };
  });
  PHOTOS.forEach(function (p) {
    byId[p.id] = { id: p.id, name: p.guest_name, thumb: p.thumb_path };
  });

  // Seed `picked` only from CURRENTLY VISIBLE winners (issue #661 edge case,
  // recorded here rather than left implicit): a former winner whose photo
  // has since been taken down has no grid tile to toggle off, so seeding it
  // into `picked` would let a re-rank silently try to re-release an
  // invisible photo — task-badges.releaseRanking refuses that whole POST
  // (every entry must be currently visible), which would otherwise trap the
  // host in a re-rank they cannot complete. Excluding it here instead keeps
  // every id `picked` ever holds pointed at a real, currently-toggleable
  // grid tile. `picked` is therefore the EDITOR's own model, never the
  // Results view's: a taken-down winner is invisible to a re-rank (correctly
  // excluded here) but still holds the badge/points, so renderRankList()
  // below reads the full WINNERS set — not `picked` — while `editing` is
  // false, and only falls back to this visible-only subset once the host
  // actually enters edit mode (issue #892 PR review, major).
  var visibleIds = {};
  PHOTOS.forEach(function (p) {
    visibleIds[p.id] = true;
  });
  var picked = WINNERS.filter(function (w) {
    return visibleIds[w.submission_id];
  }).map(function (w) {
    return w.submission_id;
  });

  var released = app.getAttribute('data-released') === '1';
  // The released ranking as loaded — the "nothing changed" reference. Edit
  // mode's Release button appears only while `picked` differs from this.
  // Deliberately a snapshot of the VISIBLE-only `picked` above, not of
  // WINNERS: a re-rank can only ever act on currently-toggleable photos, so
  // the dirty-compare baseline must live in that same visible-only space —
  // Cancel restores exactly what edit mode could have started from, and the
  // Results view (rendered from WINNERS, never from `picked`/`baseline`)
  // shows the full award truth independently of either.
  var baseline = picked.slice();
  // Results view for a released task; live editor otherwise. Flipped only by
  // the explicit Edit-ranking / Cancel buttons (issue #892), never by a
  // stray tap.
  var editing = !released;

  var pickSection = document.getElementById('pickSection');
  var pickGrid = document.getElementById('pickGrid');
  var pickTitle = document.getElementById('pickTitle');
  var pickSub = document.getElementById('pickSub');
  var pickLimit = document.getElementById('pickLimit');
  var rankList = document.getElementById('rankList');
  var rankEmpty = document.getElementById('rankEmpty');
  var rankTotal = document.getElementById('rankTotal');
  var releaseBtn = document.getElementById('releaseBtn');
  var editBtn = document.getElementById('editBtn');
  var cancelEditBtn = document.getElementById('cancelEditBtn');
  var awardedPill = document.getElementById('awardedPill');
  var rankCardTitle = document.getElementById('rankCardTitle');
  var releaseForm = document.getElementById('rankReleaseForm');
  var winnersInput = document.getElementById('rankWinnersInput');

  function isDirty() {
    return picked.join(',') !== baseline.join(',');
  }

  function togglePick(id) {
    if (!editing) return;
    var idx = picked.indexOf(id);
    if (idx !== -1) {
      picked.splice(idx, 1);
    } else if (picked.length < MAX) {
      picked.push(id);
    }
    render();
  }

  // ---- Drag-to-reorder (verbatim technique from admin-tasks.js/the mock) ----
  var dragLi = null;
  var grabDy = 0;

  function liItems() {
    return Array.prototype.slice.call(rankList.querySelectorAll('.rank-winner'));
  }

  function renumber() {
    liItems().forEach(function (li, i) {
      li.querySelector('.rank-medal').textContent = i + 1;
      li.querySelector('.rank-winner-pts').textContent =
        POINTS[i] + ' pt' + (POINTS[i] === 1 ? '' : 's');
      li.classList.toggle('is-gold', i === 0);
    });
  }

  function reorder(y) {
    var all = liItems();
    var firstTop = {};
    all.forEach(function (c) {
      firstTop[c.getAttribute('data-id')] = c.getBoundingClientRect().top;
    });
    var others = all.filter(function (c) {
      return c !== dragLi;
    });
    var after = null;
    for (var i = 0; i < others.length; i++) {
      var box = others[i].getBoundingClientRect();
      if (y < box.top + box.height / 2) {
        after = others[i];
        break;
      }
    }
    if (after) rankList.insertBefore(dragLi, after);
    else rankList.appendChild(dragLi);
    renumber();
    others.forEach(function (c) {
      var delta = firstTop[c.getAttribute('data-id')] - c.getBoundingClientRect().top;
      if (!delta) return;
      c.style.transition = 'none';
      c.style.transform = 'translateY(' + delta + 'px)';
      c.getBoundingClientRect(); // force reflow, locking the start frame
      c.style.transition = '';
      c.style.transform = '';
    });
  }

  function follow(y) {
    dragLi.style.transform = '';
    var top = dragLi.getBoundingClientRect().top;
    dragLi.style.transform = 'translateY(' + (y - grabDy - top) + 'px) scale(1.02)';
  }

  function wireHandle(handle) {
    if (!handle) return;
    handle.addEventListener('pointerdown', function (event) {
      var li = handle.closest('.rank-winner');
      if (!li || !editing) return;
      dragLi = li;
      grabDy = event.clientY - li.getBoundingClientRect().top;
      li.classList.add('is-dragging');
      follow(event.clientY);
      try {
        handle.setPointerCapture(event.pointerId);
      } catch (_) {
        // Non-fatal — move/up still track via the listeners below.
      }
      event.preventDefault();
    });
    handle.addEventListener('pointermove', function (event) {
      if (!dragLi) return;
      event.preventDefault();
      reorder(event.clientY);
      follow(event.clientY);
    });
    function endDrag(event) {
      if (!dragLi) return;
      var li = dragLi;
      dragLi = null;
      li.classList.remove('is-dragging');
      li.style.transform = '';
      try {
        handle.releasePointerCapture(event.pointerId);
      } catch (_) {
        // Non-fatal — capture may already be gone (e.g. cancel).
      }
      // Re-sync the model from the settled DOM order — no fetch here (unlike
      // admin-tasks.js's persistOrder): this page has no per-drop
      // persistence endpoint, only the Release form submit.
      picked = liItems().map(function (c) {
        return Number(c.getAttribute('data-id'));
      });
      renderGrid();
      // A reorder can create (or undo) a difference from the released
      // baseline — refresh the foot so the Release button tracks it
      // (issue #892) without rebuilding the just-settled list.
      updateFoot();
    }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
  }

  function renderGrid() {
    pickGrid.innerHTML = '';
    PHOTOS.forEach(function (p) {
      var rank = picked.indexOf(p.id);
      var isPicked = rank !== -1;
      // p.guest_name is GUEST-CONTROLLED (the display name they picked) —
      // escaped before it reaches this innerHTML-built attribute (issue #661
      // PR review, blocker: an unescaped name here is stored XSS in the
      // host's admin session, no CSP backstop). p.thumb_path/p.photo_path are
      // system-generated filenames (photos.js's own storage allowlist), never
      // guest-authored text, so they need no escaping.
      var displayName = p.guest_name || 'Guest #' + p.guest_id;
      var safeName = escapeHtml(displayName);
      var imgHtml = '<img src="/thumbs/' + p.thumb_path + '" alt="Photo by ' + safeName + '" />';
      if (editing) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className =
          'pick-tile' + (isPicked ? ' is-picked' : '') + (rank === 0 ? ' is-first' : '');
        btn.innerHTML =
          imgHtml + '<span class="pick-check">' + (isPicked ? rank + 1 : '') + '</span>';
        btn.addEventListener('click', function () {
          togglePick(p.id);
        });
        pickGrid.appendChild(btn);
      } else {
        // Results view (issue #892, owner direction 2026-07-28): the grid is
        // a plain browsable wall — the tile is a standard lightbox trigger
        // in the ADMIN variant (a BUTTON, no href: /p/:id is guest-gated and
        // would 302 an admin to /join — admin-photos.ejs's own shape), never
        // a pick control, so a tap can't disturb a released ranking.
        // data-lightbox-photo carries p.photo_path (the FULL-resolution
        // original filename, the route's own SELECT — see admin.js's
        // stmtVisibleTaskPhotosForRank), not p.thumb_path: lightbox.js
        // prefixes it with /uploads/ on open, so this must be the original,
        // never the thumbnail.
        var viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.className = 'pick-tile js-lightbox';
        viewBtn.setAttribute('data-lightbox-group', 'rank');
        viewBtn.setAttribute('data-lightbox-photo', p.photo_path);
        viewBtn.setAttribute('data-lightbox-alt', 'Photo by ' + displayName);
        viewBtn.setAttribute('data-lightbox-by', displayName);
        viewBtn.innerHTML = imgHtml;
        pickGrid.appendChild(viewBtn);
      }
    });
    // Heading, sub copy, and the picked counter read for the mode: editor
    // instructions while editing, a plain "Photos" label on the results
    // wall. Both elements are always present in this page's own markup, so
    // no existence guard is needed.
    pickTitle.textContent = editing ? 'Choose winners' : 'Photos';
    pickSub.hidden = !editing;
    pickLimit.hidden = !editing;
    pickLimit.textContent =
      picked.length +
      ' of ' +
      MAX +
      ' picked' +
      (picked.length >= MAX ? ' — remove one to swap in another' : '');
  }

  function renderRankList() {
    rankList.innerHTML = '';
    // Issue #892 PR review, major: the Results view renders the AWARD TRUTH
    // (WINNERS, server-ordered 1st..Kth, `rank`/`points` read straight off
    // each row) — never `picked`, which is visibility-filtered and would
    // silently drop a winner whose photo was taken down AFTER release even
    // though task-badges.js's own currentRanking() keeps the award row (its
    // LEFT JOIN comment: "the award row survives a takedown"). Edit mode is
    // the opposite: it can only ever act on currently-visible photos, so it
    // stays on `picked`/POINTS (the client's own live-drag copy) exactly as
    // before.
    var entries = editing
      ? picked.map(function (id, i) {
          return { id: id, rank: i + 1, points: POINTS[i] };
        })
      : WINNERS.map(function (w) {
          return { id: w.submission_id, rank: w.rank, points: w.points };
        });
    rankEmpty.hidden = entries.length > 0;
    // The empty line reads for the view it sits in: an editor with no picks
    // still points at the grid; a results view with no winners just states
    // the outcome (a zero-winner release is valid, issue #892).
    rankEmpty.textContent = editing ? 'Pick a photo above to start ranking.' : 'No winners.';
    entries.forEach(function (entry, i) {
      var id = entry.id;
      var p = byId[id] || { id: id, name: 'Guest', thumb: '' };
      // p.name is GUEST-CONTROLLED (their display name) — escaped once here
      // and reused at both sinks below (the handle's aria-label and the
      // rank-winner-name span), rather than escaping inline at each call
      // site where it would be easy to add a THIRD sink later and forget it
      // (issue #661 PR review, blocker).
      var safeName = escapeHtml(p.name);
      var li = document.createElement('li');
      li.className = 'rank-winner' + (i === 0 ? ' is-gold' : '');
      var handle = !editing
        ? ''
        : '<button type="button" class="rank-handle" aria-label="Drag to reorder ' +
          safeName +
          '">' +
          '<svg viewBox="0 0 24 24" aria-hidden="true">' +
          '<circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/>' +
          '<circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/>' +
          '<circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/>' +
          '</svg></button>';
      li.setAttribute('data-id', id);
      // p.thumb is a system-generated filename (photos.js's own storage
      // allowlist), never guest-authored text, so it needs no escaping —
      // same reasoning as renderGrid's p.thumb_path above.
      li.innerHTML =
        '<span class="rank-medal">' +
        entry.rank +
        '</span>' +
        '<img class="rank-winner-thumb" src="/thumbs/' +
        p.thumb +
        '" alt="" width="44" height="44" />' +
        '<div class="rank-winner-meta">' +
        '<span class="rank-winner-name">' +
        safeName +
        '</span>' +
        '<span class="rank-winner-pts">' +
        entry.points +
        ' pt' +
        (entry.points === 1 ? '' : 's') +
        '</span>' +
        '</div>' +
        '<span class="rank-controls">' +
        handle +
        '</span>';
      if (editing) {
        wireHandle(li.querySelector('.rank-handle'));
      }
      rankList.appendChild(li);
    });
  }

  function updateFoot() {
    var n = picked.length;
    var resultsView = !editing;
    // The foot shows only the action you can actually take (issue #892,
    // owner direction 2026-07-28): "Edit ranking" on the results view,
    // Release once the ranking genuinely differs, and nothing while editing
    // with no change yet. No greyed buttons; the medal list itself is the
    // results, so no summary sentence either. An emptied ranking IS a valid
    // change -- "everyone posted junk" must never force the host to reward
    // someone -- so unpicking every winner offers "Release - no winners"
    // instead of hiding the button.
    var canRelease = !resultsView && isDirty();
    editBtn.hidden = !resultsView;
    releaseBtn.hidden = !canRelease;
    releaseBtn.textContent = n === 0 ? 'Release — no winners' : 'Release badge & points';
    // Cancel only while EDITING a released ranking (owner direction): it
    // returns to the results view, so a never-released task has nothing to
    // cancel back to.
    cancelEditBtn.hidden = resultsView || !released;
    rankTotal.className = 'rank-award-total';
    if (canRelease) {
      rankTotal.innerHTML =
        'Releases the badge to ' + (n === 1 ? 'this winner' : 'these ' + n + ' winners') + '.';
    } else {
      rankTotal.textContent = '';
    }
  }

  function render() {
    renderGrid();
    renderRankList();
    var resultsView = !editing;
    // The photos stay visible in BOTH modes (owner direction 2026-07-28) —
    // nothing here ever sets pickSection.hidden; renderGrid() decides
    // whether the tiles are pick controls or a lightbox wall, and swaps the
    // section's heading/copy to match.
    awardedPill.hidden = !resultsView;
    rankCardTitle.textContent = resultsView ? 'Results' : 'Ranking';
    updateFoot(); // owns editBtn/cancelEditBtn/releaseBtn visibility
  }

  editBtn.addEventListener('click', function () {
    editing = true;
    render();
    // The pick grid materializes ABOVE the results card the button sits in --
    // off-screen on a phone, so entering edit mode looked like nothing
    // happened (owner: "in edit ranking i want to see photos"). Bring the
    // photos to the eye.
    pickSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });

  cancelEditBtn.addEventListener('click', function () {
    picked = baseline.slice();
    editing = false;
    render();
  });

  releaseBtn.addEventListener('click', function () {
    // The real POST (issue #892 phase 2): the server accepts an empty
    // winners list as a deliberate clear (task-badges.releaseRanking), so
    // there is no client-side short-circuit for the zero-winner case -- the
    // form always submits and the route/service decide the outcome.
    winnersInput.value = picked.join(',');
    if (typeof releaseForm.requestSubmit === 'function') {
      releaseForm.requestSubmit();
    } else {
      releaseForm.submit();
    }
  });

  render();
})();
