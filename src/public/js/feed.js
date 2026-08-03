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
//      either opens the matching <dialog id="comments-dialog-<id>"> via
//      showModal(). Native <dialog> is the load-bearing choice (#248
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
//   6. Likers dialog (issue #890): the "N likes" link opens a matching
//      <dialog id="likes-dialog-<submissionId>"> the same way (data-open-
//      likes/data-close-likes, one-dialog-at-a-time via openModalDialog).
//      On a like-toggle response the "N likes" text/aria-label update in
//      place, and the signed-in guest's own row is inserted into (or
//      removed from) that dialog without a reload — see updateLikesDialog.
//   7. In-flight guards (issue #934): toggleLike, postComment, and
//      deleteComment each arm a PER-FORM guard (beginInFlight below) before
//      their fetch — a second tap on the SAME form while one is pending is
//      ignored outright (no second fetch), while every OTHER card's controls
//      stay live (the guard's state lives on that one form element, never a
//      module-global flag). The guard force-releases after
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
   * caller MUST gate its response processing on that return — `if (!release())
   * return;` — so a late-settling abandoned request cannot mutate the DOM
   * (hide a fresh error line, append a stale payload) after the guest has
   * already given up on it and retried. Only guarding the guest STATE (the
   * token) is not enough; the response handler must short-circuit too.
   *
   * @param {HTMLFormElement} form
   * @param {function(): void} [onRelease] - extra cleanup (e.g. restoring a
   *   button's disabled/label state) run exactly once, whichever path
   *   releases first: the caller's own settle, or the watchdog.
   * @returns {(function(): boolean)|null}
   */
  function beginInFlight(form, onRelease) {
    if (form.dataset.pendingToken) {
      return null;
    }
    var token = String(Date.now()) + '-' + Math.random();
    form.dataset.pendingToken = token;

    var released = false;
    function release() {
      if (released || form.dataset.pendingToken !== token) {
        return false;
      }
      released = true;
      delete form.dataset.pendingToken;
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
    };
  }

  /**
   * Build the signed-in guest's own likers-dialog row — mirrors the
   * `.likes-row` markup src/views/feed.ejs renders server-side for every
   * other liker, from the identity selfGuest() above supplies. data-likes-row
   * is the SAME row-identity hook feed.ejs stamps on every server-rendered
   * row (not a client-only marker) — see updateLikesDialog below for why
   * that single shared hook matters.
   */
  function selfLikesRowNode(guest) {
    var a = document.createElement('a');
    a.className = 'likes-row';
    a.setAttribute('href', '/u/' + guest.id);
    a.setAttribute('data-likes-row', guest.id);

    var avatar = document.createElement('span');
    avatar.className = 'likes-row-avatar';
    if (guest.avatar) {
      var img = document.createElement('img');
      img.src = '/uploads/' + guest.avatar;
      img.alt = '';
      avatar.appendChild(img);
    } else {
      avatar.setAttribute('aria-hidden', 'true');
      avatar.textContent = guest.initialsText;
    }
    a.appendChild(avatar);

    var name = document.createElement('span');
    name.className = 'likes-row-name';
    name.textContent = guest.name;
    a.appendChild(name);

    return a;
  }

  /**
   * Insert or remove the signed-in guest's own row in a photo's likes
   * dialog, and keep the "No likes yet." empty state in sync — removed when
   * the first row goes in, restored when the last one comes out (issue #890
   * AC5). A no-op when the dialog isn't on the page or guest is null (no
   * .feed root found).
   *
   * The lookup below matches data-likes-row — the ONE row-identity hook
   * feed.ejs stamps on EVERY row, not a client-only marker distinguishing
   * "self" rows from server-rendered ones. That single shared hook is load-
   * bearing: a guest who already liked a photo before this page loaded has
   * their row rendered server-side with no client-side memory of it — an
   * unlike must still find and remove THAT row (not skip it for lacking a
   * client-only marker), and a later re-like must not duplicate it.
   */
  function updateLikesDialog(submissionId, liked, guest) {
    if (!guest) {
      return;
    }
    var dialog = document.getElementById('likes-dialog-' + submissionId);
    if (!dialog) {
      return;
    }
    var thread = dialog.querySelector('.likes-thread');
    if (!thread) {
      return;
    }
    var existingRow = thread.querySelector('[data-likes-row="' + guest.id + '"]');
    if (liked) {
      if (!existingRow) {
        var empty = thread.querySelector('.comments-dialog-empty');
        if (empty && empty.parentNode) {
          empty.parentNode.removeChild(empty);
        }
        thread.insertBefore(selfLikesRowNode(guest), thread.firstChild);
      }
    } else if (existingRow && existingRow.parentNode) {
      existingRow.parentNode.removeChild(existingRow);
      if (thread.querySelectorAll('.likes-row').length === 0) {
        var emptyP = document.createElement('p');
        emptyP.className = 'muted comments-dialog-empty';
        emptyP.textContent = 'No likes yet.';
        thread.appendChild(emptyP);
      }
    }
  }

  // ------------------------------------------------------------------
  // Comments dialog: open / close.
  // ------------------------------------------------------------------

  /** The comments <dialog> for a submission id, or null. */
  function dialogFor(submissionId) {
    return document.getElementById('comments-dialog-' + submissionId);
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

  /** Open a card's comments dialog as a modal and focus the composer. */
  function openComments(submissionId) {
    var dialog = dialogFor(submissionId);
    if (!dialog) {
      return;
    }
    openModalDialog(dialog);
    var textarea = dialog.querySelector('textarea[name="body"]');
    if (textarea) {
      syncComposer(dialog);
      textarea.focus();
    }
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
      var likesDialog = document.getElementById(
        'likes-dialog-' + likesOpener.getAttribute('data-open-likes')
      );
      if (likesDialog) {
        openModalDialog(likesDialog);
      }
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
    var target = event.target;
    if (
      target.classList &&
      target.classList.contains('comments-dialog') &&
      typeof target.close === 'function'
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
   * .comment-menu markup src/views/feed.ejs renders server-side (issue #338,
   * revised to the kebab pattern 2026-07-10). A comment this client just
   * posted is always the signed-in guest's own, so the menu is unconditional
   * here (the ownership check that decides whether to render it at all lives
   * once, server-side, in feed.ejs's `c.guest_id === guest.id`) — this only
   * builds markup for a comment already known to be self-authored.
   */
  function commentItemNode(comment, submissionId) {
    var wrap = document.createElement('div');
    wrap.className = 'feed-comment-item';
    wrap.appendChild(commentNode(comment));

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
   * the "See all <N> comments" line) from the dialog's thread — the one full
   * list already on the page — so the card and the dialog can never disagree.
   */
  function refreshCardPreview(article, dialog, submissionId, commentCount) {
    if (!article || !dialog) {
      return;
    }
    var badge = article.querySelector('.comment-count');
    if (badge) {
      badge.textContent = String(commentCount);
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

    var thread = dialog.querySelectorAll('.comments-dialog-thread .feed-comment');
    var recent = Array.prototype.slice.call(thread).slice(-4);
    while (container.firstChild) {
      container.removeChild(container.firstChild);
    }
    recent.forEach(function (node) {
      var row = node.cloneNode(true);
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
    seeAll.textContent = 'See all ' + commentCount + ' comment' + (commentCount === 1 ? '' : 's');
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
    // flight sends nothing — the guard is per FORM/card, so another card's
    // composer stays fully usable. postButton's disabled/label state is
    // restored by the SAME release path whether it comes from the fetch
    // settling or the watchdog firing (AC4 — a hung request can't mute Post).
    var postButton = form.querySelector('.comment-post');
    var postButtonRestingLabel = postButton ? postButton.textContent : 'Post';
    var release = beginInFlight(form, function () {
      if (postButton) {
        postButton.disabled = false;
        postButton.textContent = postButtonRestingLabel;
      }
    });
    if (!release) {
      return;
    }
    if (postButton) {
      postButton.disabled = true;
      // U+2026 ellipsis, per the phase-1 owner-approved copy (issue #934).
      postButton.textContent = 'Posting…';
    }

    var dialog = form.closest('dialog');
    var errorEl = dialog ? dialog.querySelector('.comment-error') : null;

    var action = form.getAttribute('action');
    // The submission id comes from the form's POST target (/p/<id>/comments),
    // a route contract — not from any DOM id's presentation format.
    var idMatch = /\/p\/(\d+)\/comments/.exec(action);
    var submissionId = idMatch ? idMatch[1] : null;
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
        if (!release()) {
          return;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
        if (!dialog) {
          return;
        }
        var threadEl = dialog.querySelector('.comments-dialog-thread');
        if (threadEl) {
          var empty = threadEl.querySelector('.comments-dialog-empty');
          if (empty && empty.parentNode) {
            empty.parentNode.removeChild(empty);
          }
          threadEl.appendChild(commentItemNode(data.comment, submissionId));
          threadEl.scrollTop = threadEl.scrollHeight;
        }
        refreshCardPreview(form.closest('.feed-item'), dialog, submissionId, data.commentCount);
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
        // does not raise this line over a newer request's state.
        if (!release()) {
          return;
        }
        if (errorEl) {
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
    var submissionId = idMatch ? idMatch[1] : null;
    var item = form.closest('.feed-comment-item');
    var dialog = form.closest('dialog');
    var article = form.closest('.feed-item');
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
      .then(function (data) {
        // Issue #934: a stale settle (watchdog fired, or a newer delete
        // re-armed this form) must not remove the row or hide a newer
        // request's error line.
        if (!release()) {
          return;
        }
        if (errorEl) {
          errorEl.hidden = true;
        }
        if (item && item.parentNode) {
          item.parentNode.removeChild(item);
        }
        if (dialog) {
          var threadEl = dialog.querySelector('.comments-dialog-thread');
          if (threadEl && threadEl.querySelectorAll('.feed-comment').length === 0) {
            var empty = document.createElement('p');
            empty.className = 'muted comments-dialog-empty';
            empty.textContent = 'No comments yet.';
            threadEl.appendChild(empty);
          }
        }
        refreshCardPreview(article, dialog, submissionId, data.commentCount);
      })
      .catch(function () {
        // Issue #934 AC3: a rate-limited (429) or rejected/5xx'd delete
        // degrades to the dialog's own quiet inline line — never a
        // full-page re-POST, the same fallback toggleLike/postComment use
        // above. A stale late rejection does not raise this line over a
        // newer request's state.
        if (!release()) {
          return;
        }
        if (errorEl) {
          errorEl.hidden = false;
        }
      });
  }
})();
