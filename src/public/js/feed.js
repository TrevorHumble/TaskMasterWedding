// src/public/js/feed.js
// Progressive enhancement for the feed card (issue #194 AC3 option b, and
// #248's comments dialog as amended 2026-07-08):
//   1. Like toggle: intercept the like form's submit and toggle via fetch —
//      the server answers { liked, likeCount } to an Accept: application/json
//      request — then update the count and the button's pressed state in
//      place. The highest-frequency tap in the app must not cost a full page
//      re-download. A rejected fetch or a non-ok response (issue #934) shows
//      the card's pre-rendered `.feed-action-error` line in place instead —
//      never a full-page re-POST, which would throw the guest off the feed
//      and lose their scroll position. The plain form POST survives only as
//      the no-JS baseline (`!window.fetch` below).
//   2. Comments dialog: the comment button and the "See all <N> comments"
//      line both carry data-open-comments="<submissionId>" — a click on
//      either fills the page's ONE <dialog id="comments-dialog"> from that
//      card's .feed-card-data payload and opens it via showModal() (issue
//      #1139; before that, each card carried its own dialog and the click
//      only had to find it by id). Native <dialog> is the load-bearing
//      choice (#248
//      amendment): .feed-item's content-visibility containment turns each
//      card into the containing block for position: fixed descendants, so a
//      fixed scrim/panel pins to the card, not the viewport — the top layer
//      that showModal() renders into escapes that containment, and the
//      background becomes inert (one dialog at a time). Escape closes
//      natively; the close button (data-close-comments) and a backdrop
//      click close here.
//   3. Composer: the dialog's textarea auto-grows with its content (height
//      driven by scrollHeight, capped by the CSS max-height after which it
//      scrolls internally), and the Post control is muted (disabled) while
//      the field is empty or whitespace.
//   4. In-place posting: the dialog form submits via fetch with Accept:
//      application/json — the server answers { comment, commentCount } — and
//      the client appends the comment to the dialog thread, updates the
//      comment-button badge, the "See all <N>" line, and the card's 4
//      preview rows, then clears and re-shrinks the textarea. A rejected
//      fetch or a non-ok response (issue #934) shows the dialog's
//      pre-rendered `.comment-error` line instead of the plain form POST
//      fallback (no navigation); the Post button reads "Posting…" and is
//      disabled for the duration (see the in-flight guard below).
//   5. Comment delete (#338): each own-comment row's ⋯ menu is a native
//      <details>/<summary> disclosure that opens/closes with no JS. The
//      `.comment-delete-form` inside it (`[data-delete-comment]` button)
//      carries the same data-confirm attribute the app's admin pages use
//      (src/public/js/admin.js) — this page has no admin.js, so this file
//      re-runs that exact check (window.confirm, cancel -> preventDefault,
//      stop) before fetching the delete route with Accept: application/json.
//      On success the row (menu included) is removed from the dialog thread
//      and the card preview/badge/See-all line are refreshed in place; a
//      rejected fetch or a non-ok response (issue #934) shows the dialog's
//      `.comment-error` line instead. Any other open menu is closed on an
//      outside tap.
//   6. Likers dialog (issue #890): the "N likes" link fills and opens the
//      page's ONE <dialog id="likes-dialog"> the same way (data-open-likes/
//      data-close-likes, one-dialog-at-a-time via openModalDialog).
//      On a like-toggle response the "N likes" text/aria-label update in
//      place, and the signed-in guest's own row is inserted into (or
//      removed from) that dialog without a reload — see updateLikesDialog.
//   7. In-flight guards (issue #934): toggleLike, postComment, and
//      deleteComment each arm a PER-FORM guard (beginInFlight below) before
//      their fetch — a second tap on the SAME form while one is pending is
//      ignored outright (no second fetch). The guard's state lives on that
//      one form element, never a module-global flag, so every OTHER like
//      form on the page stays live. Note what #1139 changed here: the like
//      forms are still per card, but the composer and the delete forms now
//      live in the ONE shared comments dialog, so their guard is per that
//      shared form — which is also per card in practice, since one dialog
//      shows one photo at a time. The guard force-releases after
//      IN_FLIGHT_RELEASE_MS even if the fetch never settles, so a dropped
//      request can never permanently mute a control.
'use strict';

(function () {
  if (typeof document === 'undefined') {
    return;
  }

  document.addEventListener('submit', function (event) {
    var form = event.target;
    if (!form.classList || !window.fetch) {
      return;
    }
    if (form.classList.contains('like-form')) {
      event.preventDefault();
      toggleLike(form);
    } else if (form.classList.contains('comments-dialog-form')) {
      event.preventDefault();
      postComment(form);
    } else if (form.classList.contains('comment-delete-form')) {
      // Same data-confirm convention as src/public/js/admin.js's submit
      // handler (this page never loads admin.js, so the check is repeated
      // here): a message and a declined confirm cancels the submit outright,
      // before any fetch runs.
      var confirmMsg = form.getAttribute('data-confirm');
      if (confirmMsg && !window.confirm(confirmMsg)) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      deleteComment(form);
    }
  });

  // ------------------------------------------------------------------
  // Per-form in-flight guard (issue #934 AC1/AC2/AC4). A trained double-tap
  // on a heart or a Post button must send exactly one request, and a hung
  // fetch (the dropped-radio case this issue is filed from) must never mute
  // a control forever. Both properties come from ONE mechanism, keyed on the
  // form element itself — never a module-global flag, which would mute
  // every OTHER card's controls too while one card's request is in flight.
  // ------------------------------------------------------------------

  // Named per issue #934 AC4: long enough that a slow venue-wifi round trip
  // still completes normally, short enough that a guest who gives up on a
  // hung request and taps again is never locked out for long.
  var IN_FLIGHT_RELEASE_MS = 10000;

  /**
   * Arm a per-form in-flight guard. Returns null if `form` is ALREADY
   * pending (a tap landed while a prior request on this exact form is still
   * in flight) — the caller's job is to return immediately in that case,
   * before ever calling fetch, so the double-tap sends nothing. Otherwise
   * returns a `release` function the caller must call from both its settle
   * path (fetch resolved or rejected) AND nowhere else — the watchdog below
   * calls it on its own if the caller never does.
   *
   * `release` is idempotent and stale-safe: it no-ops once already released,
   * and it no-ops if a NEWER call to beginInFlight has since re-armed the
   * same form (a late response from an abandoned request must not clear a
   * DIFFERENT, newer request's own in-flight state) — enforced by comparing
   * a fresh token against the one stamped on the form at arm time.
   *
   * `release` RETURNS whether it actually acted: `true` on the one call that
   * releases this request's own token, `false` on any no-op (already released,
   * or the watchdog fired first, or a newer request re-armed the form). A
   * caller MUST consult that return before mutating the DOM, so a
   * late-settling abandoned request cannot hide a fresh error line or append
   * a stale payload after the guest has given up on it and retried. Only
   * guarding the guest STATE (the token) is not enough; the response handler
   * has to branch on it too.
   *
   * `toggleLike` takes the simple form of that rule (`if (!release()) return;`).
   * The two shared-comments-dialog callers (#1139) cannot: their photo's
   * PAYLOAD must be updated even on a `false`, because the comment really was
   * posted or deleted and the card has to show it. They capture the answer and
   * branch on it instead — payload unconditionally, then an append or a full
   * redraw of the shared thread depending on whether this settle is still the
   * current one. See postComment and deleteComment.
   *
   * @param {HTMLFormElement} form
   * @param {function(): void} [onRelease] - extra cleanup (e.g. restoring a
   *   button's disabled/label state) run exactly once, whichever path
   *   releases first: the caller's own settle, or the watchdog.
   * @returns {(function(): boolean)|null}
   */
  function beginInFlight(form, onRelease, scope) {
    // `scope` exists for the ONE shared composer (#1139). Without it, a post
    // pending on photo A would block Post on photo B, because both are the
    // same form element. A tap for a DIFFERENT scope is allowed to arm, and
    // supersedes the older one under the same rule a re-armed form always
    // followed. Callers with a genuinely per-element form (the like forms)
    // pass no scope and behave exactly as before.
    var scopeKey = scope === undefined || scope === null ? '' : String(scope);
    if (form.dataset.pendingToken && form.dataset.pendingScope === scopeKey) {
      return null;
    }
    var token = String(Date.now()) + '-' + Math.random();
    form.dataset.pendingToken = token;
    form.dataset.pendingScope = scopeKey;

    var released = false;
    function release() {
      if (released || form.dataset.pendingToken !== token) {
        return false;
      }
      released = true;
      delete form.dataset.pendingToken;
      delete form.dataset.pendingScope;
      clearTimeout(watchdog);
      if (onRelease) {
        onRelease();
      }
      return true;
    }

    var watchdog = setTimeout(release, IN_FLIGHT_RELEASE_MS);
    return release;
  }

  // ------------------------------------------------------------------
  // Like toggle (issue #194). Issue #890 AC5 extends the success handler
  // below: the "N likes" link (article's only remaining .like-count — the
  // heart button lost its own count span in #890, plus its own
  // .likes-link-word span) updates count and pluralization in place, and
  // the likers dialog's own row set is kept truthful the same place, via
  // updateLikesDialog below.
  // ------------------------------------------------------------------
  function toggleLike(form) {
    // Issue #934 AC2: a double-tap on the SAME heart while the first toggle
    // is still in flight sends nothing — the trained double-tap gesture
    // must not like-then-unlike itself. Other cards' forms are untouched.
    var release = beginInFlight(form);
    if (!release) {
      return;
    }
    var article = form.closest('.feed-item');
    var errorEl = article ? article.querySelector('.feed-action-error') : null;

    fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'same-origin',
      // Issue #284: Object.assign merges the CSRF header in without
      // clobbering Accept.
      headers: Object.assign(
        { Accept: 'application/json' },
        window.csrfHeader ? window.csrfHeader() : {}
      ),
    })
      .then(function (res) {
        // A blocked self-like (#712) comes back 403 — you can't vote for your
        // own photo. Play a small "nope" fail animation and record nothing
        // (#788), rather than falling through to a full-page form POST.
        if (res.status === 403) {
          nopeLike(form);
          return null;
        }
        if (!res.ok) {
          throw new Error('like toggle failed: ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        // Issue #934: bail if this settle is stale (the watchdog already
        // released, or a newer tap re-armed the form) — a late response must
        // not hide a fresh error line or apply a stale count.
        if (!release()) {
          return;
        }
        // Issue #934 AC3: a settled (non-throwing) response — including the
        // handled 403 above — is not the failure this line exists for; keep
        // it hidden/re-hide it in case a PRIOR tap on this same card left it
        // showing.
        if (errorEl) {
          errorEl.hidden = true;
        }
        if (data === null) {
          return;
        }
        if (!article) {
          return;
        }
        // The pluralized word lives in its own .likes-link-word span
        // (feed.ejs) rather than a bare text node, so it updates the same
        // simple way the count span below does — no text-node splicing.
        var likesLink = article.querySelector('.likes-link');
        // Issue #647: on a photo a couple-flagged guest liked, the row reads
        // "<names> and N other likes" and .like-count holds N — the OTHERS
        // count, not the total the server just returned. data-couple-count
        // (feed.ejs) publishes how many of the likes are the couple's so the
        // subtraction happens here rather than the total being written into a
        // span labelled "other". Absent on every ordinary photo, where the
        // attribute reads null, coupleCount is 0, and shown === the total —
        // the pre-#647 behavior, unchanged.
        var coupleCount = likesLink ? Number(likesLink.getAttribute('data-couple-count')) || 0 : 0;
        // Math.max(0, ...) is the floor that keeps the DEGRADED case sane, not
        // decoration: data-couple-count is server-rendered once, so a couple
        // member who unlikes their own photo from a loaded page sends the
        // total to 0 while the attribute still reads 1 — a bare subtraction
        // yields -1, which then renders "-1 other likes" AND unhides both
        // tails at once (neither `=== 0` nor `> 0` holds for a negative).
        // Clamped, that same window degrades to a merely stale count, which
        // is the limitation this feature already accepts.
        var shown = Math.max(0, data.likeCount - coupleCount);
        var count = article.querySelector('.like-count');
        if (count) {
          count.textContent = String(shown);
        }
        if (likesLink) {
          var likesWord = (coupleCount > 0 ? 'other like' : 'like') + (shown === 1 ? '' : 's');
          var word = likesLink.querySelector('.likes-link-word');
          if (word) {
            word.textContent = likesWord;
          }
          // The two pre-rendered tails (feed.ejs): "and N other likes" once
          // anyone else has liked it, "liked this" while the couple is the
          // only liker. Toggling `hidden` keeps the TAILS' copy authored in
          // one place (the view) rather than rebuilt here — the pluralized
          // word above is the one string this file does re-derive, matching
          // the like/likes duplication that predates #647.
          var othersTail = likesLink.querySelector('.likes-link-others');
          var soloTail = likesLink.querySelector('.likes-link-solo');
          if (othersTail && soloTail) {
            othersTail.hidden = shown === 0;
            soloTail.hidden = shown > 0;
          }
          // The screen-reader label stays the TOTAL — "see who liked this"
          // opens a list of every liker, the couple included.
          likesLink.setAttribute(
            'aria-label',
            'See who liked this photo — ' +
              data.likeCount +
              ' like' +
              (data.likeCount === 1 ? '' : 's')
          );
        }
        var button = form.querySelector('.like-button');
        if (button) {
          button.classList.toggle('like-button-liked', data.liked);
          button.setAttribute('aria-pressed', data.liked ? 'true' : 'false');
          // The pop animation belongs to the TOGGLE, not the liked state —
          // animating the state class would make every already-liked heart
          // pop once on page load. Re-adding after a reflow restarts the
          // animation on rapid repeat taps.
          button.classList.remove('like-button-pop');
          if (data.liked) {
            void button.offsetWidth;
            button.classList.add('like-button-pop');
          }
        }
        // Issue #890 AC5: keep the likers dialog's own row set truthful
        // without a reload — the signed-in guest's own row goes in on like,
        // out on unlike. The submission id comes from the form's POST target
        // (/p/<id>/like), the same route-contract idiom postComment/
        // deleteComment already use for their own id extraction below.
        var likeActionMatch = /\/p\/(\d+)\/like/.exec(form.getAttribute('action'));
        if (likeActionMatch) {
          updateLikesDialog(likeActionMatch[1], data.liked, selfGuest());
        }
      })
      .catch(function () {
        // Issue #934 AC3: a rate-limited (429) or rejected/5xx'd toggle
        // degrades to the card's own quiet inline line — never a full-page
        // re-POST, which would navigate the guest off the feed and lose
        // their scroll position. A stale late rejection (the watchdog already
        // fired, or a newer tap re-armed the form) must not raise this line
        // over the newer request's own state.
        if (!release()) {
          return;
        }
        if (errorEl) {
          errorEl.hidden = false;
        }
      });
  }

  // Play the "nope" shake on a blocked self-like (#788). Re-adding the class
  // after a reflow restarts the animation on repeat taps, the same trick the
  // like-button-pop animation above uses.
  function nopeLike(form) {
    var button = form.querySelector('.like-button');
    if (!button) {
      return;
    }
    button.classList.remove('like-button-nope');
    void button.offsetWidth;
    button.classList.add('like-button-nope');
  }

  // ------------------------------------------------------------------
  // Shared dialogs (issue #1139). The page carries ONE likers dialog and ONE
  // comments dialog, not a pair per card. Each card publishes the rows its
  // dialogs need as a compact JSON block (.feed-card-data, src/views/feed.ejs)
  // and the shared dialogs are filled from it on open.
  //
  // That block is also the SOURCE OF TRUTH for a card's dialog contents while
  // the page is alive, not a page-load snapshot the DOM then diverges from: a
  // like toggle, a posted comment and a deleted comment each write back to it
  // and then re-render. Without the write-back, a guest who likes a photo,
  // closes the dialog and re-opens it would watch their own like disappear —
  // the failure the per-card dialogs could not have, because their DOM was
  // the only copy.
  // ------------------------------------------------------------------

  /** The <article> for a submission id, or null. Validated via photoId. */
  function cardFor(submissionId) {
    var id = photoId(submissionId);
    return id ? document.getElementById('photo-' + id) : null;
  }

  // The placeholder name src/views/feed.ejs renders the Couple's Heart
  // template with, so this file can substitute a liker's name into the
  // partial's own aria-label sentence without re-writing that sentence.
  var COUPLE_HEART_NAME_SLOT = '{name}';

  /**
   * A submission id as a plain digit string, or null if it is anything else.
   *
   * Every id this file acts on arrives as DOM text (a card's
   * data-open-comments / data-open-likes attribute) or as a capture from a
   * route path, and it is then concatenated into a URL, an element id and a
   * CSS selector. Server-rendered ids are always integers, so nothing legal is
   * turned away — but "the server only writes integers there" is an assumption
   * about a different file, and the sinks below are a form action a comment
   * would POST to and a querySelector that throws on a malformed selector.
   * Validating at the boundary makes those sinks safe by construction rather
   * than by trust.
   */
  function photoId(value) {
    if (!/^[0-9]+$/.test(String(value))) {
      return null;
    }
    // Rebuilt from the NUMBER rather than returned as the original text. The
    // regex above already rejects anything but digits, so this changes no
    // accepted value — but the string that leaves here is derived from a
    // numeric conversion, which is what makes it, and every sink downstream,
    // provably independent of the page content it came from. Returning the
    // input string after testing it looks equivalent and is not: the value
    // flowing out would still be the untrusted one.
    var n = Number(String(value));
    return Number.isSafeInteger(n) && n > 0 ? String(n) : null;
  }

  /** A card's payload <script> block, or null. */
  function cardDataEl(submissionId) {
    var id = photoId(submissionId);
    var card = id ? cardFor(id) : null;
    // Matched on data-for as well as the class, so the id the block claims and
    // the card it sits in have to agree in the code the guest runs — not only
    // in the tests.
    return card ? card.querySelector('.feed-card-data[data-for="' + id + '"]') : null;
  }

  /**
   * Read a card's dialog payload. Returns the parsed object with `likers` and
   * `comments` guaranteed to be arrays, or null when the card or its block is
   * absent or unparseable — every caller treats null as "nothing to draw"
   * rather than throwing, so a malformed block costs one dialog, never the
   * page's other handlers.
   *
   * Any OTHER key the block carries is passed through untouched, so a field
   * added to feed.ejs's payload later is not silently dropped by the first
   * write-back on that card.
   */
  function readCardData(submissionId) {
    var el = cardDataEl(submissionId);
    if (!el) {
      return null;
    }
    try {
      var cardData = JSON.parse(el.textContent);
      if (!cardData || typeof cardData !== 'object') {
        return null;
      }
      if (!Array.isArray(cardData.likers)) {
        cardData.likers = [];
      }
      if (!Array.isArray(cardData.comments)) {
        cardData.comments = [];
      }
      return cardData;
    } catch (_err) {
      return null;
    }
  }

  /** Write a card's dialog payload back after a live change. */
  function writeCardData(submissionId, cardData) {
    var el = cardDataEl(submissionId);
    if (el) {
      el.textContent = JSON.stringify(cardData);
    }
  }

  /**
   * The submission id a shared dialog is currently showing, or null.
   *
   * This is the guard every handler that touches shared dialog DOM has to
   * consult. One dialog serves every card, so a request that settles after
   * the guest has switched photos — a slow post on venue wifi, up to
   * IN_FLIGHT_RELEASE_MS — would otherwise write photo A's comment into
   * photo B's open thread. The per-card dialogs could not reach that state.
   */
  function shownSubmissionId(dialog) {
    return dialog ? dialog.getAttribute('data-submission-id') : null;
  }

  /** Whether a shared dialog is currently showing `submissionId`. */
  function dialogShows(dialog, submissionId) {
    return !!dialog && String(shownSubmissionId(dialog)) === String(submissionId);
  }

  /**
   * Copy the card's own thumbnail into a shared dialog's header. The dialogs
   * used to carry a server-rendered <img src="/thumbs/…"> each; reading it off
   * the card keeps the thumbnail path out of the payload entirely, and it is
   * already loaded, so the header draws with no second request.
   */
  function fillDialogThumb(dialog, submissionId) {
    var card = cardFor(submissionId);
    var cardImg = card ? card.querySelector('.feed-photo') : null;
    var thumb = dialog.querySelector('.comments-dialog-thumb');
    if (thumb && cardImg) {
      thumb.src = cardImg.getAttribute('src');
    }
  }

  /** Remove every child of `el`. */
  function clearChildren(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  /** A <p class="muted comments-dialog-empty"> carrying `text`. */
  function emptyStateNode(text) {
    var p = document.createElement('p');
    p.className = 'muted comments-dialog-empty';
    p.textContent = text;
    return p;
  }

  // ------------------------------------------------------------------
  // Likers dialog (issue #890): keep the row set truthful after a like
  // toggle, with no reload and no round trip for the guest's own identity.
  // ------------------------------------------------------------------

  /**
   * The signed-in guest's own identity, read once from the .feed root's data
   * attributes (src/views/feed.ejs, issue #890 AC5). The like-toggle response
   * carries only { liked, likeCount } (POST /p/:submissionId/like,
   * community.js) — never guest identity — so this is the sole source for
   * building or matching their own likers-dialog row client-side. The
   * initials fallback is likewise read pre-computed (data-guest-initials),
   * rather than re-implementing src/utils/initials.js's algorithm here in a
   * second place. Returns null off any page with no .feed root (e.g. a bare
   * fragment in a test), so callers can no-op rather than throw.
   */
  function selfGuest() {
    var root = document.querySelector('.feed');
    if (!root) {
      return null;
    }
    return {
      id: root.getAttribute('data-guest-id'),
      name: root.getAttribute('data-guest-name') || 'Guest',
      avatar: root.getAttribute('data-guest-avatar') || '',
      initialsText: root.getAttribute('data-guest-initials') || '?',
      couple: root.getAttribute('data-guest-couple') === '1',
    };
  }

  /**
   * The Couple's Heart for a liker row (issue #647), cloned from the single
   * <template id="couple-heart-template"> src/views/feed.ejs renders once via
   * partials/couple-heart-mark.ejs. The partial is the mark's ONE renderer
   * across every surface, so the art is cloned rather than rebuilt here; only
   * the aria-label is per-row, naming the couple member whose row it is.
   * Returns null when the template is absent, so the row simply renders
   * without the mark rather than throwing.
   */
  function coupleHeartNode(name) {
    var tpl = document.getElementById('couple-heart-template');
    var source = tpl && tpl.content ? tpl.content.firstElementChild : null;
    if (!source) {
      return null;
    }
    var node = source.cloneNode(true);
    // The label SENTENCE is the partial's, not this file's: feed.ejs renders
    // the template with the placeholder name below, so "Loved by …" is still
    // authored in exactly one place and only the name is substituted here.
    // Re-composing the prefix in JavaScript would be a second owner for copy
    // the partial exists to own.
    var label = node.getAttribute('aria-label') || '';
    if (label.indexOf(COUPLE_HEART_NAME_SLOT) !== -1) {
      node.setAttribute('aria-label', label.split(COUPLE_HEART_NAME_SLOT).join(name));
    }
    return node;
  }

  /**
   * Build one `.likes-row` from a payload liker ({ id, name, av, init,
   * couple }) — the single builder for every row in the likers dialog,
   * whether it came from the card's payload at open time or from the
   * signed-in guest liking the photo just now (issue #1139: before this,
   * server-rendered rows and the client-built self row were two renderers of
   * the same row and could drift).
   *
   * data-likes-row is the row-identity hook every row carries, not a marker
   * distinguishing self rows: an unlike must find and remove the guest's row
   * whether it was drawn from the payload or inserted on a live like, and a
   * later re-like must not duplicate it.
   */
  function likesRowNode(row) {
    var a = document.createElement('a');
    a.className = 'likes-row';
    a.setAttribute('href', '/u/' + row.id);
    a.setAttribute('data-likes-row', row.id);

    var avatar = document.createElement('span');
    avatar.className = 'likes-row-avatar';
    if (row.av) {
      var img = document.createElement('img');
      img.src = '/uploads/' + row.av;
      img.alt = '';
      // The dialog is drawn on open, so these fetch only when the guest
      // actually asks to see the list.
      img.loading = 'lazy';
      img.decoding = 'async';
      avatar.appendChild(img);
    } else {
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = row.init || '?';
    }
    a.appendChild(avatar);

    var name = document.createElement('span');
    name.className = 'likes-row-name';
    name.textContent = row.name;
    a.appendChild(name);

    if (row.couple) {
      var heart = coupleHeartNode(row.name);
      if (heart) {
        a.appendChild(heart);
      }
    }
    return a;
  }

  /** The signed-in guest as a payload liker row, for a live like. */
  function selfLikerRow(guest) {
    var row = { id: guest.id, name: guest.name, av: guest.avatar, init: guest.initialsText };
    if (guest.couple) {
      row.couple = 1;
    }
    return row;
  }

  /**
   * Draw the shared likers dialog for `submissionId` from that card's
   * payload, and stamp which card it is showing. "No likes yet." stands in
   * for an empty list, the same copy the per-card dialog carried.
   *
   * Returns whether it drew anything; false means the card or its payload is
   * gone and the caller must not open the dialog onto the previous photo's
   * rows. Same rule, same reason, as renderComments below.
   */
  function renderLikes(rawSubmissionId) {
    var submissionId = photoId(rawSubmissionId);
    var dialog = likesDialog();
    var data = submissionId ? readCardData(submissionId) : null;
    var thread = dialog ? dialog.querySelector('.likes-thread') : null;
    if (!dialog || !data || !thread) {
      return false;
    }
    clearChildren(thread);
    if (data.likers.length === 0) {
      thread.appendChild(emptyStateNode('No likes yet.'));
    } else {
      data.likers.forEach(function (row) {
        thread.appendChild(likesRowNode(row));
      });
    }
    fillDialogThumb(dialog, submissionId);
    dialog.setAttribute('data-submission-id', String(submissionId));
    return true;
  }

  /**
   * Record the signed-in guest's like or unlike against a photo (issue #890
   * AC5), and redraw the likers dialog if it happens to be showing that photo
   * right now. The card's payload is updated either way — a like toggled
   * while the dialog is CLOSED must still be there when the guest opens it.
   *
   * A no-op when guest is null (no .feed root) or the card has no payload.
   */
  function updateLikesDialog(submissionId, liked, guest) {
    if (!guest) {
      return;
    }
    var data = readCardData(submissionId);
    if (!data) {
      return;
    }
    var already = data.likers.some(function (row) {
      return String(row.id) === String(guest.id);
    });
    if (liked && !already) {
      data.likers.unshift(selfLikerRow(guest));
    } else if (!liked && already) {
      data.likers = data.likers.filter(function (row) {
        return String(row.id) !== String(guest.id);
      });
    } else {
      return;
    }
    writeCardData(submissionId, data);

    var dialog = likesDialog();
    if (dialog && String(shownSubmissionId(dialog)) === String(submissionId)) {
      renderLikes(submissionId);
    }
  }

  // ------------------------------------------------------------------
  // Comments dialog: open / close.
  // ------------------------------------------------------------------

  /** The page's one comments <dialog>, or null. */
  function commentsDialog() {
    return document.getElementById('comments-dialog');
  }

  /** The page's one likers <dialog>, or null. */
  function likesDialog() {
    return document.getElementById('likes-dialog');
  }

  /**
   * Close any other open dialog, then showModal() this one — the shared
   * one-dialog-at-a-time invariant both the comments dialog and the likes
   * dialog need (issue #890: they share the `.comments-dialog` shell class
   * for exactly this reason — see that class's own contract note on the
   * likes <dialog> in feed.ejs). showModal makes the rest of the page
   * inert, so a user cannot open a second dialog while one is showing;
   * closing any stray open dialog first keeps that invariant even for a
   * programmatic call.
   */
  function openModalDialog(dialog) {
    var alreadyOpen = document.querySelector('dialog.comments-dialog[open]');
    if (alreadyOpen && alreadyOpen !== dialog && typeof alreadyOpen.close === 'function') {
      alreadyOpen.close();
    }
    if (!dialog.open && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
  }

  /**
   * Sync the composer to its content: auto-grow the textarea (reset, then
   * follow scrollHeight — the CSS max-height caps it, after which it scrolls
   * internally) and mute Post while the field is empty or whitespace.
   */
  function syncComposer(dialog) {
    var textarea = dialog.querySelector('textarea[name="body"]');
    if (!textarea) {
      return;
    }
    textarea.style.height = 'auto';
    textarea.style.height = textarea.scrollHeight + 'px';
    var postButton = dialog.querySelector('.comment-post');
    if (postButton) {
      postButton.disabled = textarea.value.trim() === '';
    }
  }

  // The composer's resting Post label, captured from the server-rendered
  // button the first time the dialog is drawn — before any post can have
  // changed it. Read rather than repeated here, so the copy keeps its one
  // author in src/views/feed.ejs.
  var postRestingLabel = null;

  /**
   * Hand the ONE shared composer over to a different photo: drop the draft
   * typed for the last one, and give the guest a usable Post control again.
   *
   * The button part is not cosmetic. A post still pending on photo A leaves
   * Post disabled and reading "Posting…", and that button is now the same
   * element on photo B, so without this the guest would find B's composer
   * dead for up to IN_FLIGHT_RELEASE_MS.
   *
   * What this deliberately does NOT do is clear the pending token. That would
   * make A's own settle indistinguishable from a genuinely stale one (the
   * watchdog fired and the guest retried), which is exactly the case #934's
   * guard exists to reject — and a guest who wanders to another photo and
   * back would then watch their comment fail to appear. beginInFlight's
   * `scope` handles the real need instead: a tap for a different photo is
   * allowed to arm even while A's request is outstanding.
   */
  function resetSharedComposer(dialog) {
    var textarea = dialog.querySelector('textarea[name="body"]');
    if (textarea) {
      textarea.value = '';
    }
    var postButton = dialog.querySelector('.comment-post');
    if (postButton) {
      postButton.disabled = false;
      if (postRestingLabel !== null) {
        postButton.textContent = postRestingLabel;
      }
    }
  }

  /**
   * Draw the shared comments dialog for `submissionId` from that card's
   * payload: the thread, the header thumbnail and title, and the composer's
   * POST target. One composer serves every card, so its action is set here to
   * the photo whose dialog is being opened — the id every later handler reads
   * back off that action, exactly as it read the per-card form's before.
   *
   * Returns whether it drew anything. FALSE means the card or its payload is
   * gone (removed by feed-scroll's in-place window swap, or unparseable), and
   * the caller must NOT open the dialog: it would still be showing the last
   * photo's thread, title, thumbnail and — worst — its form action, so a
   * comment typed there would post to the wrong photo. A per-card dialog could
   * not reach that state; one shared dialog can, so refusing to open is the
   * failure this shape has to define away.
   */
  function renderComments(rawSubmissionId) {
    var submissionId = photoId(rawSubmissionId);
    var dialog = commentsDialog();
    var cardData = submissionId ? readCardData(submissionId) : null;
    var thread = dialog ? dialog.querySelector('.comments-dialog-thread') : null;
    if (!dialog || !cardData || !thread) {
      return false;
    }
    var guest = selfGuest();

    if (postRestingLabel === null) {
      var restingButton = dialog.querySelector('.comment-post');
      if (restingButton) {
        postRestingLabel = restingButton.textContent;
      }
    }

    // Switching photos resets what the ONE composer carries from the last one:
    // the draft, and the in-flight state. The per-card composers each had
    // their own of both. Re-opening the SAME photo keeps the draft, which is
    // what the per-card composer did too.
    if (!dialogShows(dialog, submissionId)) {
      resetSharedComposer(dialog);
    }
    clearChildren(thread);
    if (cardData.comments.length === 0) {
      thread.appendChild(emptyStateNode('No comments yet.'));
    } else {
      cardData.comments.forEach(function (comment) {
        thread.appendChild(commentItemNode(comment, submissionId, isOwnComment(comment, guest)));
      });
    }

    fillDialogThumb(dialog, submissionId);
    var title = dialog.querySelector('.comments-dialog-title');
    var card = cardFor(submissionId);
    var byName = card ? card.querySelector('.feed-by-name') : null;
    if (title) {
      // The owner's name is already on the card; the dialog title borrows it
      // rather than the payload carrying a second copy per photo.
      title.textContent = (byName ? byName.textContent : 'Guest') + '’s photo';
    }

    var form = dialog.querySelector('.comments-dialog-form');
    if (form) {
      // submissionId is photoId()-validated above, so this POST target is a
      // literal path plus digits and cannot be steered by page content.
      form.setAttribute('action', '/p/' + submissionId + '/comments');
    }
    // A failure line raised for the LAST photo's post must not greet the
    // guest on this one.
    var errorEl = dialog.querySelector('.comment-error');
    if (errorEl) {
      errorEl.hidden = true;
    }
    dialog.setAttribute('data-submission-id', String(submissionId));
    return true;
  }

  /**
   * Whether `comment` belongs to the signed-in guest. Ownership is decided
   * here, from the .feed root's own identity, rather than stored per row in
   * the payload — one owner for the rule, matching how the likers-row insert
   * already reads that same identity (#890 AC5).
   */
  function isOwnComment(comment, guest) {
    return !!guest && String(comment.guest_id) === String(guest.id);
  }

  /**
   * Open a card's comments dialog as a modal and focus the composer. Opens
   * only if the dialog could actually be drawn for THIS photo — see
   * renderComments: a shared dialog that failed to fill is still showing the
   * last photo's thread and posting to the last photo's URL.
   */
  function openComments(submissionId) {
    var dialog = commentsDialog();
    if (!dialog || !renderComments(submissionId)) {
      return;
    }
    openModalDialog(dialog);
    var textarea = dialog.querySelector('textarea[name="body"]');
    if (textarea) {
      syncComposer(dialog);
      textarea.focus();
    }
  }

  /** Open the likers dialog for a card as a modal, on the same terms. */
  function openLikes(submissionId) {
    var dialog = likesDialog();
    if (!dialog || !renderLikes(submissionId)) {
      return;
    }
    openModalDialog(dialog);
  }

  document.addEventListener('click', function (event) {
    var opener = event.target.closest && event.target.closest('[data-open-comments]');
    if (opener) {
      openComments(opener.getAttribute('data-open-comments'));
      return;
    }
    // Likers list (issue #890): "N likes" opens the matching likes dialog —
    // openModalDialog owns the same one-dialog-at-a-time invariant
    // openComments above uses.
    var likesOpener = event.target.closest && event.target.closest('[data-open-likes]');
    if (likesOpener) {
      openLikes(likesOpener.getAttribute('data-open-likes'));
      return;
    }
    // Close: the comments dialog's close button (data-close-comments) and
    // the likes dialog's (data-close-likes) are the identical action on two
    // different dialog shells, so one branch handles both.
    var closer =
      event.target.closest && event.target.closest('[data-close-comments], [data-close-likes]');
    if (closer) {
      var dialog = closer.closest('dialog');
      if (dialog && typeof dialog.close === 'function') {
        dialog.close();
      }
      return;
    }
    // Backdrop click: the dialog element itself is the click target only
    // when the click lands outside its children — i.e. on the ::backdrop.
    // Issue #1041: that alone isn't enough — a drag-select started inside
    // the composer and released past the dialog's edge retargets the click
    // to the dialog the same way a genuine backdrop press does. The guarded
    // read of window.DialogDismiss's delegated predicate (src/public/js/
    // dialog-dismiss.js) additionally requires the PRESS to have landed on
    // the dialog too; if the module never loaded, this falls back to
    // today's click-target-only check rather than losing dismissal.
    var target = event.target;
    if (
      target.classList &&
      target.classList.contains('comments-dialog') &&
      typeof target.close === 'function' &&
      (!window.DialogDismiss || window.DialogDismiss.pressAllowsDelegatedClose(event))
    ) {
      target.close();
    }

    // Outside tap closes any open ⋯ menu (#338): the native <details> only
    // closes on a second tap of its own <summary>, so a tap elsewhere in the
    // thread (another row, the composer, the dialog header) is handled here.
    var insideMenu = event.target.closest && event.target.closest('.comment-menu');
    closeCommentMenus(insideMenu);
  });

  // Auto-grow + Post-mute tracking as the guest types.
  document.addEventListener('input', function (event) {
    var field = event.target;
    if (!field.matches || !field.matches('.comments-dialog textarea[name="body"]')) {
      return;
    }
    var dialog = field.closest('dialog');
    if (dialog) {
      syncComposer(dialog);
    }
  });

  // ------------------------------------------------------------------
  // Comments dialog: in-place posting.
  // ------------------------------------------------------------------

  /** Build the shared comment markup: <p class="feed-comment"><a>Name</a> body</p>. */
  function commentNode(comment) {
    var p = document.createElement('p');
    p.className = 'feed-comment';
    var a = document.createElement('a');
    a.setAttribute('href', '/u/' + comment.guest_id);
    a.textContent = comment.guest_name || 'Guest';
    p.appendChild(a);
    p.appendChild(document.createTextNode(' ' + comment.body));
    return p;
  }

  /**
   * Build one dialog-thread row for a just-posted comment: the shared
   * commentNode() <p>, plus its own ⋯ actions menu (native <details>) with
   * the Delete control inside — mirroring the .feed-comment-item /
   * .comment-menu markup the per-card dialog used to render server-side
   * (issue #338, revised to the kebab pattern 2026-07-10).
   *
   * Issue #1139: this is now the builder for EVERY row in the shared comments
   * dialog, not only for a comment the guest just posted, so `own` decides
   * whether the ⋯ menu is built. Its one caller for a fresh post passes true —
   * a comment this client just posted is always the guest's own — and
   * renderComments passes isOwnComment() for a payload row.
   */
  function commentItemNode(comment, submissionId, own) {
    var wrap = document.createElement('div');
    wrap.className = 'feed-comment-item';
    wrap.appendChild(commentNode(comment));
    if (!own) {
      return wrap;
    }

    var menu = document.createElement('details');
    menu.className = 'comment-menu';

    var summary = document.createElement('summary');
    summary.className = 'comment-menu-trigger';
    summary.setAttribute('aria-label', 'Comment actions');
    summary.textContent = '⋯';
    menu.appendChild(summary);

    var form = document.createElement('form');
    form.method = 'post';
    form.action = '/p/' + submissionId + '/comments/' + comment.id + '/delete';
    form.className = 'comment-delete-form';
    form.setAttribute('data-confirm', "Delete this comment? This can't be undone.");

    var button = document.createElement('button');
    button.type = 'submit';
    button.className = 'comment-delete';
    button.setAttribute('data-delete-comment', String(comment.id));
    button.textContent = 'Delete';
    form.appendChild(button);

    menu.appendChild(form);
    wrap.appendChild(menu);
    return wrap;
  }

  /** Close every open .comment-menu <details> except (optionally) one. */
  function closeCommentMenus(except) {
    var openMenus = document.querySelectorAll('.comment-menu[open]');
    Array.prototype.forEach.call(openMenus, function (menu) {
      if (menu !== except) {
        menu.removeAttribute('open');
      }
    });
  }

  /**
   * Rebuild the card's comment preview (the 4 most-recent one-line rows plus
   * the "See all <N> comments" line) from THAT CARD'S OWN payload, which is
   * the source of truth the dialog is also drawn from, so the card and the
   * dialog cannot disagree.
   *
   * Reading the card's payload rather than the shared dialog's thread is the
   * load-bearing part (issue #1139). One dialog serves every card, so a
   * request that settles after the guest switched photos would otherwise
   * rebuild card A's preview out of photo B's visible thread — pasting B's
   * comments onto A's card. Sourcing from the card makes that unrepresentable
   * rather than guarded against.
   */
  function refreshCardPreview(submissionId) {
    var article = cardFor(submissionId);
    var cardData = readCardData(submissionId);
    if (!article || !cardData) {
      return;
    }
    // The badge counts the payload, not the number the response happened to
    // carry: the payload is what the dialog will show on the next open, so
    // deriving the badge from anything else lets the card and the dialog
    // disagree after a late settle.
    var badge = article.querySelector('.comment-count');
    if (badge) {
      badge.textContent = String(cardData.comments.length);
    }

    var container = article.querySelector('.feed-comments');
    if (!container) {
      // First comment on a card that rendered with none: create the block
      // where the server-rendered one lives, right after the action row.
      var actionbar = article.querySelector('.feed-actionbar');
      if (!actionbar || !actionbar.parentNode) {
        return;
      }
      container = document.createElement('div');
      container.className = 'feed-comments';
      actionbar.parentNode.insertBefore(container, actionbar.nextSibling);
    }

    // "4 lines, not 4 comments" (#248 owner amendment): the card shows the 4
    // most recent, same slice src/views/feed.ejs takes server-side.
    var recent = cardData.comments.slice(-4);
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    recent.forEach(function (comment) {
      var row = commentNode(comment);
      row.classList.add('feed-comment-row');
      container.appendChild(row);
    });

    var seeAll = document.createElement('button');
    seeAll.type = 'button';
    seeAll.className = 'see-all-comments';
    // The id is carried explicitly (as everywhere else — see the comment
    // button and the server-rendered See-all button in feed.ejs), never
    // reverse-parsed from the article's `photo-<id>` DOM id, whose format is
    // the template's representation decision, not this consumer's to know.
    seeAll.setAttribute('data-open-comments', String(submissionId));
    var total = cardData.comments.length;
    seeAll.textContent = 'See all ' + total + ' comment' + (total === 1 ? '' : 's');
    container.appendChild(seeAll);
  }

  function postComment(form) {
    var textarea = form.querySelector('textarea[name="body"]');
    var body = textarea ? textarea.value.trim() : '';
    if (body === '') {
      // Post is muted while empty; this guards programmatic submits too.
      return;
    }
    // Issue #934 AC1: a double-tap on Post while the first POST is still in
    // flight sends nothing. The guard is per form, and since #1139 there is
    // ONE composer form for the page — switching the dialog to another photo
    // hands it over via resetSharedComposer, which is what keeps a pending
    // post on one photo from muting Post on the next. postButton's
    // disabled/label state is
    // restored by the SAME release path whether it comes from the fetch
    // settling or the watchdog firing (AC4 — a hung request can't mute Post).
    var dialog = form.closest('dialog');
    var errorEl = dialog ? dialog.querySelector('.comment-error') : null;

    var action = form.getAttribute('action');
    // The submission id comes from the form's POST target (/p/<id>/comments),
    // a route contract — not from any DOM id's presentation format.
    var idMatch = /\/p\/(\d+)\/comments/.exec(action);
    var submissionId = idMatch ? idMatch[1] : null;

    var postButton = form.querySelector('.comment-post');
    var postButtonRestingLabel = postButton ? postButton.textContent : 'Post';
    // Scoped to the photo (#1139): the double-tap this rejects is a second tap
    // on the SAME photo's Post, not a first tap on another photo's, which is a
    // different request the one shared composer must still be able to send.
    var release = beginInFlight(
      form,
      function () {
        if (postButton) {
          postButton.disabled = false;
          postButton.textContent = postButtonRestingLabel;
        }
      },
      submissionId
    );
    if (!release) {
      return;
    }
    if (postButton) {
      postButton.disabled = true;
      // U+2026 ellipsis, per the phase-1 owner-approved copy (issue #934).
      postButton.textContent = 'Posting…';
    }
    fetch(action, {
      method: 'POST',
      credentials: 'same-origin',
      // Issue #284: Object.assign merges the CSRF header in without
      // clobbering Accept/Content-Type.
      headers: Object.assign(
        {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        window.csrfHeader ? window.csrfHeader() : {}
      ),
      body: 'body=' + encodeURIComponent(body),
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('comment post failed: ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
        // Issue #934: a stale settle (watchdog fired, or a newer Post
        // re-armed this form) must not append a duplicate comment or hide a
        // newer request's error line.
        // release() is called for its effects (clear the watchdog, restore
        // Post) but its answer does NOT gate the payload write below. The
        // comment was accepted by the server, so the card must show it even
        // when this settle is "stale" in #934's sense — which now includes
        // the ordinary case of the guest switching the shared dialog to
        // another photo mid-flight, since that hands the one composer over
        // and clears its token (issue #1139).
        var acted = release();

        // The card's payload is the source of truth the dialog and the card
        // preview are both drawn from. Keyed by comment id so a retry after
        // a watchdog release cannot double-insert the same comment.
        var cardData = readCardData(submissionId);
        if (cardData) {
          var known = cardData.comments.some(function (c) {
            return String(c.id) === String(data.comment.id);
          });
          if (!known) {
            cardData.comments.push(data.comment);
            writeCardData(submissionId, cardData);
          }
        }
        refreshCardPreview(submissionId);

        // Everything below touches the ONE shared dialog, so it runs only for
        // a settle that is still current (#934: a hung request that the
        // watchdog released and the guest retried must not append a stale
        // comment or hide the retry's error line) AND only while that dialog
        // is still showing THIS photo (#1139: a slow post the guest gave up
        // on, closing it and opening another photo well inside
        // IN_FLIGHT_RELEASE_MS on venue wifi, must not append their comment
        // into the other photo's open thread, clear the draft they have
        // started there, or steal focus).
        //
        // Wandering to another photo and back is NOT either of those, and
        // still lands here with acted true: the hand-over leaves the token
        // alone precisely so this case stays distinguishable from a stale
        // settle. See resetSharedComposer.
        if (!acted || !dialogShows(dialog, submissionId)) {
          return;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
        var threadEl = dialog.querySelector('.comments-dialog-thread');
        if (threadEl) {
          var empty = threadEl.querySelector('.comments-dialog-empty');
          if (empty && empty.parentNode) {
            empty.parentNode.removeChild(empty);
          }
          threadEl.appendChild(commentItemNode(data.comment, submissionId, true));
          threadEl.scrollTop = threadEl.scrollHeight;
        }
        if (textarea) {
          textarea.value = '';
        }
        syncComposer(dialog);
        if (textarea) {
          textarea.focus();
        }
      })
      .catch(function () {
        // Issue #934 AC3: a rate-limited (429) or rejected/5xx'd post
        // degrades to the dialog's own quiet inline line — never a
        // full-page re-POST, which would duplicate-risk on any auto-retry
        // and always throws the guest off the feed. A stale late rejection
        // does not raise this line over a newer request's state — and
        // (#1139) a failure on the photo the guest has since navigated away
        // from does not raise it over the photo they are looking at now.
        if (!release()) {
          return;
        }
        if (errorEl && dialogShows(dialog, submissionId)) {
          errorEl.hidden = false;
        }
      });
  }

  // ------------------------------------------------------------------
  // Comment delete (#338): confirm is handled by the submit listener above
  // before this ever runs.
  // ------------------------------------------------------------------
  function deleteComment(form) {
    var action = form.getAttribute('action');
    // The submission id comes from the form's POST target
    // (/p/<submissionId>/comments/<commentId>/delete), a route contract —
    // not from any DOM id's presentation format (same rule postComment
    // follows for its own id extraction above).
    var idMatch = /\/p\/(\d+)\/comments\/\d+\/delete/.exec(action);
    var commentIdMatch = /\/comments\/(\d+)\/delete/.exec(action);
    var submissionId = idMatch ? idMatch[1] : null;
    var dialog = form.closest('dialog');
    // Issue #1139: nothing else is found by walking up from the form. The card
    // is reached by the submission id the delete route names (inside
    // refreshCardPreview), and the row is not captured at all — the settle
    // redraws the thread from the payload instead, because a captured node can
    // be detached by an intervening redraw.
    var errorEl = dialog ? dialog.querySelector('.comment-error') : null;

    // Issue #934: a per-form guard on this exact delete form — a repeated
    // tap on the confirm dialog while the first delete is in flight sends
    // nothing. The Delete button is disabled for the duration and restored
    // by the same release path the watchdog can also trigger (AC4).
    var deleteButton = form.querySelector('.comment-delete');
    var release = beginInFlight(form, function () {
      if (deleteButton) {
        deleteButton.disabled = false;
      }
    });
    if (!release) {
      return;
    }
    if (deleteButton) {
      deleteButton.disabled = true;
    }

    fetch(action, {
      method: 'POST',
      credentials: 'same-origin',
      // Issue #284: Object.assign merges the CSRF header in without
      // clobbering Accept.
      headers: Object.assign(
        { Accept: 'application/json' },
        window.csrfHeader ? window.csrfHeader() : {}
      ),
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('comment delete failed: ' + res.status);
        }
        return res.json();
      })
      .then(function () {
        // Issue #934: a stale settle (watchdog fired, or a newer delete
        // re-armed this form) must not remove the row or hide a newer
        // request's error line.
        // Same shape as postComment above: release() for its effects, then
        // the payload unconditionally, because the comment IS deleted and
        // must be gone on the next open whether or not the guest is still
        // looking at this photo (issue #1139). The filter is idempotent, so
        // a repeat settle cannot corrupt anything.
        var acted = release();
        var cardData = readCardData(submissionId);
        if (cardData && commentIdMatch) {
          cardData.comments = cardData.comments.filter(function (c) {
            return String(c.id) !== commentIdMatch[1];
          });
          writeCardData(submissionId, cardData);
        }
        refreshCardPreview(submissionId);

        // Same two conditions as postComment above: a current settle, and the
        // dialog still on this photo.
        if (!acted || !dialogShows(dialog, submissionId)) {
          return;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
        // Redraw the thread from the freshly-filtered payload rather than
        // unhooking the row this handler captured at submit time (issue
        // #1139). One dialog serves every card, so between the submit and
        // this settle the guest may have opened another photo and come back,
        // which rebuilds the thread — the captured node is then detached and
        // removing it changes nothing on screen, leaving the deleted comment
        // visible with a live Delete control that would re-POST a delete for
        // a row the server no longer has. Redrawing is idempotent and cannot
        // go stale, and it owns the "No comments yet." empty state in one
        // place instead of two.
        renderComments(submissionId);
      })
      .catch(function () {
        // Issue #934 AC3: a rate-limited (429) or rejected/5xx'd delete
        // degrades to the dialog's own quiet inline line — never a
        // full-page re-POST, the same fallback toggleLike/postComment use
        // above. A stale late rejection does not raise this line over a
        // newer request's state, and (#1139) a failure on a photo the guest
        // has navigated away from does not raise it on the one they see.
        if (!release()) {
          return;
        }
        if (errorEl && dialogShows(dialog, submissionId)) {
          errorEl.hidden = false;
        }
      });
  }
})();
