// src/public/js/badge-moment.js
// Issue #255: opens the badge-earned modal on load and wires its Continue
// button. Mirrors the native <dialog> pattern from #248's comments dialog
// (src/public/js/feed.js) — showModal()/close(); Escape (or any other native dismissal)
// dismiss natively, no code needed for either. No polling: the dialog is
// either present in the initial render (a badge was just earned) or absent.
//
// The shared #badge-dialog markup moved from src/views/task.ejs into
// src/views/partials/header.ejs (issue #644 plan step 4), so this script is
// now included by header.ejs — every guest page, not just the task page —
// but ONLY when a badgeMoment is owed, so #badge-dialog always exists
// (already populated server-side) when this file runs. Looked up by ID —
// the element carries both `id="badge-dialog"` and `class="badge-dialog"`,
// but the id is the unique one (#902).
//
// The 'playing' class gates the bloom animation in base.css (itself gated
// under prefers-reduced-motion: no-preference); adding it under reduced
// motion is harmless since no rule in that media block ever matches.
//
// Issue #902 — continue-through queue: header.ejs's withBadgeMoment
// (src/services/render-locals.js) resolves and stamps only the HEAD of this
// render's owed badge queue (already baked into the dialog markup below,
// same as before this issue); every remaining owed badge rides along as
// header.ejs's #badge-queue-data list — one data-carrying <li> per badge,
// art pre-rendered server-side through the same partials/badge-art.ejs every
// other badge display uses. This script reads that list ONCE at load, then
// drives the "Continue — N more" -> ... -> "Done" advance-in-place flow the
// owner approved on the ?badge-demo=1 mock (recap.js, now removed): each tap
// repaints the dialog via src/public/js/recap.js's shared window.paintBadge
// (#902) — one function now owns the .badge-title/.badge-sub/.badge-sway
// swap, called from both here and recap.js's own openBadgeDialog — and
// posts POST /badge-moment/celebrated for the badge just revealed
// (AC3 — a stamp fires only once a badge is actually SHOWN, never before,
// and is not retried on failure, matching POST /recap/seen's own
// fire-and-forget posture). A single-badge celebration (no queue) behaves
// byte-identically to before this issue: "Continue" closes.
//
// This script also OWNS every '.badge-continue' click for the rest of this
// page load, including a LATER recap-row REPLAY tap (src/public/js/recap.js
// repopulates the same #badge-dialog for that case, with no queue of its
// own): once `queueIndex` reaches the end of `queueItems` — either by
// walking every queued badge via Continue, OR because the dialog's native
// 'close' event fast-forwarded it there (see the close listener below) — its
// click handler degrades to a plain close, which is exactly what a replay's
// Continue button should do (AC6). recap.js's own close-on-Continue listener
// is therefore never the one that actually runs on any page where this
// script is loaded at all; see that file's own comment on the same branch.
//
// A CAPTURE-phase document listener is required for that, not an ordinary
// bubble one: recap.js registers its own '.badge-continue' -> dialog.close()
// listener on `document` in the bubble phase, and both scripts' listeners
// live on the SAME node (document) — script load order does not decide
// firing order between two listeners on one node; only the phase does.
// Capture-phase listeners on an ancestor always run before any bubble-phase
// listener on that same ancestor (the event travels down through capture
// before it ever bubbles back up), so registering here with capture:true and
// calling stopPropagation() guarantees this handler decides every Continue
// tap first, regardless of which script tag happens to appear first in
// header.ejs.
//
// Issue #902 PR review, major finding 1 (a real broken trace, all three
// reviews found it): a guest owed 3 badges who DISMISSES the dialog
// mid-queue (Escape, any native dismissal — never a click on
// .badge-continue, so the capture listener above never runs and never
// touches `queueIndex`) leaves `queueIndex` sitting wherever it was when the
// dialog closed. Without the 'close' listener below, a LATER recap-row
// replay reopening this same dialog and tapping Continue would resume the
// STALE queue — advancing to the next abandoned badge, posting its stamp,
// and showing a count — instead of just closing (AC6 violated, and AC3's
// "abandon keeps it owed" silently broken by the very tap meant to replay a
// DIFFERENT badge). The 'close' listener forces `queueIndex` to the end the
// moment the dialog closes, by ANY means, so a dismissed-mid-queue guest's
// remaining badges stay genuinely owed for the next render (AC3), and any
// later replay's Continue plainly closes (AC6) — never resumes.
'use strict';

(function () {
  if (typeof document === 'undefined') {
    return;
  }

  var dialog = document.getElementById('badge-dialog');
  if (!dialog || typeof dialog.showModal !== 'function') {
    return;
  }

  // The queued remainder (positions 2..K), read once at load from header.ejs's
  // hidden #badge-queue-data list — absent entirely for a single-badge
  // celebration (AC4), in which case queueItems stays empty and the very
  // first Continue tap below falls straight to the close branch, unchanged
  // from this script's pre-#902 behavior.
  var queueItems = [];
  var queueList = document.getElementById('badge-queue-data');
  if (queueList) {
    Array.prototype.forEach.call(queueList.querySelectorAll('li'), function (li) {
      queueItems.push({
        code: li.getAttribute('data-badge-code') || '',
        name: li.getAttribute('data-badge-name') || '',
        description: li.getAttribute('data-badge-description') || '',
        artHtml: li.getAttribute('data-badge-art-html') || '',
      });
    });
  }
  var queueIndex = 0; // queueItems[queueIndex] is the next badge a Continue tap reveals

  var continueButton = dialog.querySelector('.badge-continue');

  // Opens the dialog if it isn't already, and (re)starts the bloom entrance
  // animation from its 0% frame — used both for this script's own first
  // paint and for every later queue advance, so there is one owner of "how
  // does this dialog (re)enter," not a duplicated showModal/reflow/class
  // sequence at each call site (issue #902 PR review, minor finding 6).
  function openAndReplay() {
    dialog.classList.remove('playing');
    if (typeof dialog.showModal === 'function' && !dialog.open) {
      dialog.showModal();
    }
    void dialog.offsetWidth;
    dialog.classList.add('playing');
  }

  // Swap the dialog's content to `item` (via recap.js's shared
  // window.paintBadge — issue #902 PR review, major finding 2) and set the
  // Continue label to whatever `remaining` badges will still be owed after
  // this one (AC1/AC2). window.paintBadge is read lazily, at call time, not
  // captured at load: header.ejs loads this script BEFORE recap.js (defer
  // preserves document order), so recap.js has not run yet at THIS file's own
  // load time — but a click can only happen after both deferred scripts have
  // finished running, by which point recap.js has always defined it. Guarded
  // the same defensive way every other window.csrfHeader call site in this
  // app already is, in case recap.js is ever missing from a page.
  function showQueued(item, remaining) {
    if (window.paintBadge) {
      window.paintBadge(dialog, item);
    }
    if (continueButton) {
      continueButton.textContent = remaining > 0 ? 'Continue — ' + remaining + ' more' : 'Done';
    }
    openAndReplay();
  }

  // Fire-and-forget stamp for a badge just SHOWN (issue #902 AC3): posted the
  // moment a Continue tap reveals it, never before, and never retried on
  // failure — a failed stamp leaves the row owed, and it re-celebrates on
  // the guest's next render, the same safe-failure posture recap.js's own
  // markSeen() already uses for POST /recap/seen.
  function postCelebrated(code) {
    if (!window.fetch) {
      return;
    }
    fetch('/badge-moment/celebrated', {
      method: 'POST',
      credentials: 'same-origin',
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        window.csrfHeader ? window.csrfHeader() : {}
      ),
      body: JSON.stringify({ code: code }),
    }).catch(function () {});
  }

  openAndReplay();
  // showModal() (inside openAndReplay above) auto-focuses the first
  // focusable descendant (the Continue button), which paints a focus ring on
  // it — reads as a stray border on open. Move focus to the dialog itself
  // (tabindex=-1) so the modal is still focused for a11y/Escape, but no
  // control shows a ring until the guest actually tabs to it. Guard: focus()
  // only if the browser put focus inside.
  if (typeof dialog.focus === 'function') {
    dialog.focus();
  }

  // The head badge's own title/description/art are already correct in the
  // server-rendered markup (render-locals.js's resolveBadgeMoment stamped
  // and returned it as `badgeMoment`) — only the Continue label needs
  // setting up front, and only when more badges are queued behind it.
  if (queueItems.length > 0 && continueButton) {
    continueButton.textContent = 'Continue — ' + queueItems.length + ' more';
  }

  document.addEventListener(
    'click',
    function (event) {
      var target = event.target;
      if (!target || !target.closest || !target.closest('#badge-dialog .badge-continue')) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();

      if (queueIndex < queueItems.length) {
        var item = queueItems[queueIndex];
        queueIndex += 1;
        postCelebrated(item.code);
        showQueued(item, queueItems.length - queueIndex);
        return;
      }
      dialog.close();
    },
    true
  );

  // Issue #902 PR review, major finding 1 — see the file header above for
  // the full bug this closes. Dismissed mid-queue (Escape, any native dismissal —
  // any 'close' NOT caused by the capture listener's own dialog.close() call
  // above) = abandoned: force queueIndex to the end so nothing here can leak
  // into a later replay's Continue tap and resume advancing a queue this
  // guest already walked away from. A no-op on the normal path, where
  // queueIndex is already at queueItems.length by the time 'close' fires
  // (either the queue was fully walked, or it was a single-badge/replay
  // celebration with an empty queueItems to begin with).
  dialog.addEventListener('close', function () {
    queueIndex = queueItems.length;
  });
})();
