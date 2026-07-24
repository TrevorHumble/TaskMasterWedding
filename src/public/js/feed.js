// src/public/js/feed.js
// Progressive enhancement for the feed card (issue #194 AC3 option b, and
// #248's comments dialog as amended 2026-07-08):
//   1. Like toggle: intercept the like form's submit and toggle via fetch —
//      the server answers { liked, likeCount } to an Accept: application/json
//      request — then update the count and the button's pressed state in
//      place. The highest-frequency tap in the app must not cost a full page
//      re-download. Any failure falls back to the plain form POST (redirect
//      to the bounded page), which is also the no-JS path.
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
//      preview rows, then clears and re-shrinks the textarea. Any failure
//      falls back to the plain form POST (redirect), also the no-JS path.
//   5. Comment delete (#338): each own-comment row's ⋯ menu is a native
//      <details>/<summary> disclosure that opens/closes with no JS. The
//      `.comment-delete-form` inside it (`[data-delete-comment]` button)
//      carries the same data-confirm attribute the app's admin pages use
//      (src/public/js/admin.js) — this page has no admin.js, so this file
//      re-runs that exact check (window.confirm, cancel -> preventDefault,
//      stop) before fetching the delete route with Accept: application/json.
//      On success the row (menu included) is removed from the dialog thread
//      and the card preview/badge/See-all line are refreshed in place; on
//      failure (or no fetch support) the plain form POST runs, which is also
//      the no-JS path. Any other open menu is closed on an outside tap.
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
  // Like toggle (issue #194) — unchanged behavior.
  // ------------------------------------------------------------------
  function toggleLike(form) {
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
        if (data === null) {
          return;
        }
        var article = form.closest('.feed-item');
        if (!article) {
          return;
        }
        var count = article.querySelector('.like-count');
        if (count) {
          count.textContent = String(data.likeCount);
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
      })
      .catch(function () {
        // Network hiccup or unexpected response — let the ordinary form POST
        // do its redirect-based round trip instead.
        form.submit();
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
  // Comments dialog: open / close.
  // ------------------------------------------------------------------

  /** The comments <dialog> for a submission id, or null. */
  function dialogFor(submissionId) {
    return document.getElementById('comments-dialog-' + submissionId);
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
    // showModal makes the rest of the page inert, so a user cannot open a
    // second dialog while one is showing. Closing any stray open dialog
    // first keeps that invariant even for programmatic calls.
    var alreadyOpen = document.querySelector('dialog.comments-dialog[open]');
    if (alreadyOpen && alreadyOpen !== dialog && typeof alreadyOpen.close === 'function') {
      alreadyOpen.close();
    }
    if (!dialog.open && typeof dialog.showModal === 'function') {
      dialog.showModal();
    }
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
    var closer = event.target.closest && event.target.closest('[data-close-comments]');
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
        var dialog = form.closest('dialog');
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
        // Network hiccup or unexpected response — let the ordinary form POST
        // do its redirect-based round trip instead.
        form.submit();
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
        // Network hiccup or unexpected response (e.g. a stale 403/404) — let
        // the ordinary form POST do its redirect-based round trip instead,
        // the same fallback toggleLike/postComment use above.
        form.submit();
      });
  }
})();
