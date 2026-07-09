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
    }
  });

  // ------------------------------------------------------------------
  // Like toggle (issue #194) — unchanged behavior.
  // ------------------------------------------------------------------
  function toggleLike(form) {
    fetch(form.getAttribute('action'), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    })
      .then(function (res) {
        if (!res.ok) {
          throw new Error('like toggle failed: ' + res.status);
        }
        return res.json();
      })
      .then(function (data) {
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
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
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
          threadEl.appendChild(commentNode(data.comment));
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
})();
